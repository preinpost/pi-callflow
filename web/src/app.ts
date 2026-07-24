import mermaid from "mermaid";

interface CallStep {
  index: number;
  from: string;
  to: string;
  call: string;
  file: string;
  line: number;
  note?: string;
}
interface Diagram {
  title: string;
  sequence: string;
  flowchart?: string;
  steps: CallStep[];
  notes?: string;
  generatedAt: number;
}
interface EditorOption { id: string; label: string; }
type HostMessage =
  | { type: "diagram"; diagram: Diagram; index: number; total: number }
  | { type: "empty" }
  | { type: "editors"; list: EditorOption[]; selected: string | null; locked: boolean };

declare global {
  interface Window {
    __callflowReceive?: (message: HostMessage) => void;
    __CALLFLOW_BOOT__?: Diagram | null;
    glimpse?: { send: (data: unknown) => void };
  }
}

mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "loose" });

const $ = (id: string) => document.getElementById(id)!;
let renderSeq = 0;

function sendHost(data: unknown): void {
  try {
    window.glimpse?.send(data);
  } catch {
    /* browser fallback: no host channel */
  }
}

/** A pan/zoom surface wrapping an SVG. Wheel = zoom at cursor, drag = pan, buttons + dbl-click. */
class Stage {
  private readonly viewport: HTMLElement;
  private readonly content: HTMLElement;
  private scale = 1;
  private tx = 0;
  private ty = 0;
  private natural: { w: number; h: number } | null = null;

  constructor(stageEl: HTMLElement) {
    this.viewport = stageEl.querySelector(".stage-viewport") as HTMLElement;
    this.content = stageEl.querySelector(".stage-content") as HTMLElement;

    for (const btn of stageEl.querySelectorAll<HTMLButtonElement>(".zoom button")) {
      btn.addEventListener("click", () => {
        const act = btn.dataset.act;
        if (act === "in") this.zoomAtCenter(1.2);
        else if (act === "out") this.zoomAtCenter(1 / 1.2);
        else this.fit();
      });
    }

    this.viewport.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = this.viewport.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      this.zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
    }, { passive: false });

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    this.viewport.addEventListener("pointerdown", (e) => {
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      this.viewport.setPointerCapture(e.pointerId);
      this.viewport.classList.add("grabbing");
    });
    this.viewport.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      this.tx += e.clientX - lastX;
      this.ty += e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      this.apply();
    });
    const end = () => { dragging = false; this.viewport.classList.remove("grabbing"); };
    this.viewport.addEventListener("pointerup", end);
    this.viewport.addEventListener("pointercancel", end);
    this.viewport.addEventListener("dblclick", () => this.fit());
  }

  setSvg(html: string): void {
    this.content.innerHTML = html;
    const el = this.content.querySelector("svg");
    if (!el) { this.natural = null; this.scale = 1; this.tx = 12; this.ty = 12; this.apply(); return; }
    // Determine natural size from viewBox (mermaid always sets it); fall back to attrs/measure.
    const vb = el.viewBox?.baseVal;
    let w = vb && vb.width ? vb.width : parseFloat(el.getAttribute("width") || "0");
    let h = vb && vb.height ? vb.height : parseFloat(el.getAttribute("height") || "0");
    if (!w || !h) {
      const r = el.getBoundingClientRect();
      w = w || r.width || 600;
      h = h || r.height || 400;
    }
    // Pin the SVG to its natural pixel size so transforms are predictable.
    el.setAttribute("width", String(w));
    el.setAttribute("height", String(h));
    el.style.maxWidth = "none";
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    this.natural = { w, h };
    this.fit();
  }

  private zoomAt(px: number, py: number, factor: number): void {
    const next = Math.min(8, Math.max(0.1, this.scale * factor));
    const applied = next / this.scale;
    // keep the point under the cursor stationary
    this.tx = px - applied * (px - this.tx);
    this.ty = py - applied * (py - this.ty);
    this.scale = next;
    this.apply();
  }

  private zoomAtCenter(factor: number): void {
    const rect = this.viewport.getBoundingClientRect();
    this.zoomAt(rect.width / 2, rect.height / 2, factor);
  }

  /** Fit the SVG to the viewport width and center it. */
  fit(): void {
    const rect = this.viewport.getBoundingClientRect();
    const n = this.natural;
    if (!n || rect.width === 0) { this.scale = 1; this.tx = 12; this.ty = 12; this.apply(); return; }
    const s = Math.min(1, (rect.width - 24) / n.w);
    this.scale = s;
    this.tx = Math.max(12, (rect.width - n.w * s) / 2);
    this.ty = 12;
    this.apply();
  }

  private apply(): void {
    this.content.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
  }
}

let seqStage: Stage | null = null;
let flowStage: Stage | null = null;
let hasFlow = false;

function setActiveTab(tab: "seq" | "flow"): void {
  if (tab === "flow" && !hasFlow) tab = "seq";
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".tab")) {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  }
  ($("seq-stage") as HTMLElement).hidden = tab !== "seq";
  ($("flow-stage") as HTMLElement).hidden = tab !== "flow";
  // The newly shown stage had zero size while hidden; refit it now.
  (tab === "seq" ? seqStage : flowStage)?.fit();
}

function updateNav(index: number, total: number): void {
  const prev = $("prev") as HTMLButtonElement;
  const next = $("next") as HTMLButtonElement;
  $("counter").textContent = total > 0 ? `${index + 1} / ${total}` : "0 / 0";
  prev.disabled = index <= 0;
  next.disabled = index < 0 || index >= total - 1;
}

async function renderInto(stage: Stage, code: string): Promise<void> {
  const id = `callflow-${++renderSeq}`;
  try {
    const { svg } = await mermaid.render(id, code.trim());
    stage.setSvg(svg);
  } catch (error) {
    stage.setSvg(
      `<pre style="color:#ff8080;white-space:pre-wrap;font:12px monospace;padding:12px;margin:0">Mermaid render error:\n${escapeHtml(String(error))}\n\n${escapeHtml(code.trim())}</pre>`,
    );
  }
}

async function renderDiagram(diagram: Diagram): Promise<void> {
  document.body.classList.add("has-diagram");
  $("title").textContent = diagram.title;
  const kinds = diagram.flowchart ? "sequence + flowchart" : "sequence";
  $("meta").textContent = `${kinds} · ${diagram.steps.length} steps · ${new Date(diagram.generatedAt).toLocaleTimeString()}`;

  await renderInto(seqStage!, diagram.sequence);

  hasFlow = Boolean(diagram.flowchart && diagram.flowchart.trim());
  const flowTab = document.querySelector<HTMLButtonElement>('.tab[data-tab="flow"]')!;
  flowTab.classList.toggle("hidden", !hasFlow);
  if (hasFlow) await renderInto(flowStage!, diagram.flowchart!.trim());
  // Always land on the Sequence tab for a new diagram.
  setActiveTab("seq");

  renderSteps(diagram);
}

function renderSteps(diagram: Diagram): void {
  const list = $("steps");
  list.innerHTML = "";
  for (const step of diagram.steps) {
    const li = document.createElement("li");
    li.innerHTML =
      `<div class="call">${step.index}. ${escapeHtml(step.call)}</div>` +
      `<div class="flow">${escapeHtml(step.from)} → ${escapeHtml(step.to)}</div>` +
      `<div class="src">${escapeHtml(step.file)}:${step.line}</div>` +
      (step.note ? `<div class="note">${escapeHtml(step.note)}</div>` : "");
    li.addEventListener("click", () => sendHost({ type: "open-file", file: step.file, line: step.line }));
    list.appendChild(li);
  }
  ($("notes")).textContent = diagram.notes ?? "";
}

function showEmpty(): void {
  document.body.classList.remove("has-diagram");
  ($("steps")).innerHTML = "";
  ($("notes")).textContent = "";
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderEditors(list: EditorOption[], selected: string | null, locked: boolean): void {
  const wrap = $("editor-wrap");
  const select = $("editor") as HTMLSelectElement;
  if (list.length === 0) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  select.innerHTML = "";
  for (const e of list) {
    const opt = document.createElement("option");
    opt.value = e.id; opt.textContent = e.label;
    if (e.id === selected) opt.selected = true;
    select.appendChild(opt);
  }
  select.disabled = locked;
  select.title = locked ? "Locked by CALLFLOW_OPEN_CMD" : "Editor used when you click a step";
}

seqStage = new Stage($("seq-stage"));
flowStage = new Stage($("flow-stage"));

for (const btn of document.querySelectorAll<HTMLButtonElement>(".tab")) {
  btn.addEventListener("click", () => setActiveTab(btn.dataset.tab === "flow" ? "flow" : "seq"));
}

window.__callflowReceive = (message: HostMessage) => {
  if (message.type === "diagram") {
    updateNav(message.index, message.total);
    void renderDiagram(message.diagram);
  } else if (message.type === "editors") {
    renderEditors(message.list, message.selected, message.locked);
  } else {
    updateNav(-1, 0);
    showEmpty();
  }
};

$("prev").addEventListener("click", () => sendHost({ type: "navigate", direction: "prev" }));
$("next").addEventListener("click", () => sendHost({ type: "navigate", direction: "next" }));
$("close").addEventListener("click", () => sendHost({ type: "close" }));
($("editor") as HTMLSelectElement).addEventListener("change", (ev) => {
  sendHost({ type: "set-editor", id: (ev.target as HTMLSelectElement).value });
});

if (window.__CALLFLOW_BOOT__) {
  updateNav(0, 1);
  void renderDiagram(window.__CALLFLOW_BOOT__);
}

sendHost({ type: "ready" });
