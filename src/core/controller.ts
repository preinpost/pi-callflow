import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { open, type GlimpseWindow } from "glimpseui";
import { loadCallflowHtml } from "./ui.js";
import type { Diagram, EditorOption, HostMessage, PngFile, WindowMessage } from "./types.js";

interface EditorSpec {
  id: string;
  label: string;
  cmd: string;
  args: (file: string, line: number) => string[];
}

/** Known editors. Only those found on PATH are offered to the user. */
const EDITORS: EditorSpec[] = [
  { id: "code", label: "VS Code", cmd: "code", args: (f, l) => ["-g", `${f}:${l}`] },
  { id: "cursor", label: "Cursor", cmd: "cursor", args: (f, l) => ["-g", `${f}:${l}`] },
  { id: "idea", label: "IntelliJ IDEA", cmd: "idea", args: (f, l) => ["--line", String(l), f] },
  { id: "subl", label: "Sublime", cmd: "subl", args: (f, l) => [`${f}:${l}`] },
];

/** True if `cmd` resolves on PATH (uses `command -v`, or `where` on Windows). */
function isOnPath(cmd: string): boolean {
  try {
    const probe =
      process.platform === "win32"
        ? spawnSync("where", [cmd], { stdio: "ignore" })
        : spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
    return probe.status === 0;
  } catch {
    return false;
  }
}

function detectEditors(): EditorSpec[] {
  return EDITORS.filter((e) => isOnPath(e.cmd));
}

/** True when running inside WSL (Windows Subsystem for Linux). */
function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

/**
 * Pick a command to open an HTML file in the system browser.
 * CALLFLOW_BROWSER overrides everything (use {file} for the path, else it is appended).
 * On WSL, xdg-open usually does nothing, so open the Windows default browser via
 * wslview (from wslu) or explorer.exe with a translated Windows path.
 */
function resolveBrowserOpener(file: string): { cmd: string; args: string[] } {
  const override = process.env.CALLFLOW_BROWSER?.trim();
  if (override) {
    const parts = override.split(/\s+/);
    const rest = parts.slice(1);
    return {
      cmd: parts[0],
      args: rest.length ? rest.map((a) => a.replace("{file}", file)) : [file],
    };
  }
  if (process.platform === "darwin") return { cmd: "open", args: [file] };
  if (process.platform === "win32") return { cmd: "start", args: [file] };
  if (isWsl()) {
    if (isOnPath("wslview")) return { cmd: "wslview", args: [file] };
    try {
      const win = spawnSync("wslpath", ["-w", file], { encoding: "utf8" });
      if (!win.error && win.status === 0 && win.stdout.trim()) {
        return { cmd: "explorer.exe", args: [win.stdout.trim()] };
      }
    } catch {
      /* fall through to xdg-open */
    }
  }
  return { cmd: "xdg-open", args: [file] };
}

export type Notify = (message: string, level: "info" | "warning" | "error") => void;

function escapeInline(value: string): string {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function parseMessage(value: unknown): WindowMessage | null {
  if (value == null || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") return null;
  return value as WindowMessage;
}

/**
 * Owns exactly one live viewer surface for the session (Q7: server-per-window).
 * Prefers a native Glimpse window; falls back to the system browser so a missing
 * native toolchain never yields a blank/absent view.
 */
export class CallflowController {
  private window: GlimpseWindow | null = null;
  private history: Diagram[] = [];
  private cursor = -1;
  private usingBrowserFallback = false;

  private readonly available: EditorSpec[] = detectEditors();
  private selectedEditor: string | null = this.available[0]?.id ?? null;

  private get current(): Diagram | null {
    return this.cursor >= 0 && this.cursor < this.history.length ? this.history[this.cursor] : null;
  }

  /** CALLFLOW_OPEN_CMD overrides the picker; when set, the UI selector is locked. */
  private get envOverride(): string | undefined {
    const t = process.env.CALLFLOW_OPEN_CMD;
    return t && t.includes("{file}") ? t : undefined;
  }

  constructor(
    private readonly cwd: string,
    private readonly notify: Notify,
    private readonly onClosed: () => void,
  ) {}

  get isOpen(): boolean {
    return this.window != null || this.usingBrowserFallback;
  }

  /** Open the viewer (or bring it forward). Never throws; falls back to browser. */
  ensureOpen(): void {
    if (this.window != null) {
      try { this.window.show({ title: "Call Flow" }); } catch { /* ignore */ }
      return;
    }
    try {
      const window = open(loadCallflowHtml(), { width: 1280, height: 900, title: "Call Flow" });
      this.window = window;
      window.on("message", (value) => {
        const message = parseMessage(value);
        if (message != null) this.handleMessage(message);
      });
      window.on("closed", () => this.disposeWindow(window));
      window.on("error", (error) => {
        this.notify(`Call Flow window error: ${error.message}`, "warning");
        this.disposeWindow(window);
      });
    } catch (error) {
      this.notify(
        `Native window unavailable (${error instanceof Error ? error.message : String(error)}); using browser fallback.`,
        "warning",
      );
      this.openBrowserFallback();
    }
  }

  /** Push a diagram to the viewer (browser-style history: truncates any forward entries). */
  render(diagram: Diagram): void {
    if (this.cursor < this.history.length - 1) {
      this.history = this.history.slice(0, this.cursor + 1);
    }
    this.history.push(diagram);
    this.cursor = this.history.length - 1;
    if (!this.isOpen) this.ensureOpen();
    if (this.window != null) {
      this.sendCurrent();
    } else {
      // Browser fallback is static; re-open with the fresh diagram baked in.
      this.openBrowserFallback();
    }
  }

  close(): void {
    const window = this.window;
    this.window = null;
    this.usingBrowserFallback = false;
    this.history = [];
    this.cursor = -1;
    try { window?.close(); } catch { /* ignore */ }
  }

  private handleMessage(message: WindowMessage): void {
    if (message.type === "ready") {
      this.sendEditors();
      this.sendCurrent();
      return;
    }
    if (message.type === "set-editor") {
      if (this.available.some((e) => e.id === message.id)) this.selectedEditor = message.id;
      return;
    }
    if (message.type === "navigate") {
      const next = this.cursor + (message.direction === "next" ? 1 : -1);
      if (next < 0 || next >= this.history.length) return;
      this.cursor = next;
      this.sendCurrent();
      return;
    }
    if (message.type === "open-file") {
      this.openInEditor(message.file, message.line);
      return;
    }
    if (message.type === "export-png") {
      this.savePngs(message.files);
      return;
    }
    if (message.type === "close") {
      // Let the native 'closed' event drive disposal/onClosed cleanup.
      try { this.window?.close(); } catch { /* ignore */ }
    }
  }

  private sendEditors(): void {
    const list: EditorOption[] = this.available.map((e) => ({ id: e.id, label: e.label }));
    this.send({ type: "editors", list, selected: this.selectedEditor, locked: this.envOverride != null });
  }

  private sendCurrent(): void {
    const diagram = this.current;
    if (diagram == null) this.send({ type: "empty" });
    else this.send({ type: "diagram", diagram, index: this.cursor, total: this.history.length });
  }

  private send(message: HostMessage): void {
    if (this.window == null) return;
    const payload = escapeInline(JSON.stringify(message));
    try { this.window.send(`window.__callflowReceive(${payload})`); } catch { /* ignore */ }
  }

  /** Bonus over MVP: jump to code. Editor is configurable via CALLFLOW_OPEN_CMD. */
  private openInEditor(file: string, line: number): void {
    const absolute = file.startsWith("/") ? file : join(this.cwd, file);
    let cmd: string;
    let args: string[];
    const override = this.envOverride;
    if (override) {
      const filled = override.replace(/\{file\}/g, absolute).replace(/\{line\}/g, String(line));
      const parts = filled.split(/\s+/).filter(Boolean);
      cmd = parts[0];
      args = parts.slice(1);
    } else {
      const editor = EDITORS.find((e) => e.id === this.selectedEditor && this.available.some((a) => a.id === e.id));
      if (editor == null) {
        this.notify(
          "No editor available to open the file. Install `code`/`idea` or set CALLFLOW_OPEN_CMD.",
          "warning",
        );
        return;
      }
      cmd = editor.cmd;
      args = editor.args(absolute, line);
    }
    try {
      spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
    } catch (error) {
      this.notify(`Could not open editor: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }

  /** Resolve the user's Downloads directory (honours CALLFLOW_PNG_DIR, then XDG). */
  private downloadsDir(): string {
    const override = process.env.CALLFLOW_PNG_DIR?.trim();
    if (override) return override;
    const xdg = process.env.XDG_DOWNLOAD_DIR?.trim();
    if (xdg) return xdg;
    return join(homedir(), "Downloads");
  }

  /** Return `dir/name`, inserting -1, -2, … before the extension on collisions. */
  private uniquePath(dir: string, name: string): string {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let candidate = join(dir, name);
    let n = 0;
    while (existsSync(candidate)) {
      n += 1;
      candidate = join(dir, `${stem}-${n}${ext}`);
    }
    return candidate;
  }

  /** Decode the base64 PNGs from the webview and write them to the Downloads dir. */
  private savePngs(files: PngFile[]): void {
    if (!files || files.length === 0) return;
    const dir = this.downloadsDir();
    const saved: string[] = [];
    try {
      for (const f of files) {
        const comma = f.dataUrl.indexOf(",");
        const base64 = comma >= 0 ? f.dataUrl.slice(comma + 1) : f.dataUrl;
        const path = this.uniquePath(dir, f.name);
        writeFileSync(path, Buffer.from(base64, "base64"));
        saved.push(path);
      }
    } catch (error) {
      this.notify(`Could not save PNG: ${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }
    const label = saved.length === 1 ? saved[0] : `${saved.length} PNGs to ${dir}`;
    this.notify(`Saved ${label}`, "info");
  }

  private openBrowserFallback(): void {
    try {
      const html = this.injectDiagram(loadCallflowHtml(), this.current);
      const dir = mkdtempSync(join(tmpdir(), "pi-callflow-"));
      const file = join(dir, "callflow.html");
      writeFileSync(file, html, "utf8");
      const { cmd, args } = resolveBrowserOpener(file);
      spawn(cmd, args, { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
      this.usingBrowserFallback = true;
    } catch (error) {
      this.notify(`Browser fallback failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  /** For the static browser fallback: bake the current diagram into the HTML. */
  private injectDiagram(html: string, diagram: Diagram | null): string {
    const json = diagram ? JSON.stringify(diagram) : "null";
    const boot = `<script>window.__CALLFLOW_BOOT__=${escapeInline(json)};</script>`;
    return html.replace("</head>", `${boot}</head>`);
  }

  private disposeWindow(window: GlimpseWindow): void {
    if (this.window !== window) return;
    this.window = null;
    this.onClosed();
  }
}
