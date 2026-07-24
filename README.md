# pi-callflow

On-demand **call-structure viewer** for [pi](https://pi.dev). Ask the agent to show how a
request flows through the code — e.g. *"show the call structure starting from login"* — and
pi-callflow renders a live **Mermaid sequence/flowchart** in a native
[Glimpse](https://github.com/HazAT/glimpse) window, with every step grounded to a real
`file:line`.

Built for onboarding onto large codebases (e.g. a 3.5k-file Java monolith) where reading
call flows as terminal text is slow.

## How it works

1. You ask pi to show a call flow.
2. pi inspects the actual code, then calls the `render_call_diagram` tool.
3. A persistent Glimpse window shows the result in **tabs** — a **Sequence** tab (default,
   call ordering) and a **Flowchart** tab (branch logic, shown when provided) — plus a step
   panel (`from → to : call` with `file:line`).
4. Click a step to open it in your editor.

Each diagram sits on a **zoom/pan stage**: wheel zooms at the cursor, drag to pan, `+`/`−`/`⌗`
buttons and double-click to fit — handy when the flow gets large.

The tool schema **requires** a `file:line` for every step (grounding-lite), so the diagram
stays tied to real code instead of being a plausible-looking hallucination.

## Usage

One package, two ways to run it. Pick whichever agent you use.

### Option A — with pi (first-class)

Install it as a pi package — this registers the `/callflow` command and the extension in
**every project** (prebuilt viewer ships in the package, no local build):

```sh
pi install npm:pi-callflow
```

<details>
<summary>Other ways to load it</summary>

```sh
pi install -l npm:pi-callflow      # project-only (writes .pi/settings.json, shareable)
pi -e npm:pi-callflow              # one-off for a single session, no install
pi update npm:pi-callflow          # update to the latest published version
pi update --all                    # update pi + all installed packages
pi remove npm:pi-callflow          # uninstall
```
</details>

Then open pi in your project and ask for a flow, either with the `/callflow` command or in
plain language:

```sh
cd ~/dev/your-project && pi
```

```text
/callflow "show the call flow from the /login endpoint"
#  → agent analyzes the code, then the window opens with the result.

/callflow                      # (no arg) just open an empty viewer
```

```text
# plain language works too — no slash command needed:
show the call flow from the /login endpoint
```

In pi the window opens **when the agent finishes** the turn. If the agent calls the tool, the
window opens at the end of the turn.

### Option B — with Claude Code / Codex (MCP)

The same viewer is a local **stdio MCP server**, so teammates on Claude Code or Codex get the
identical `render_call_diagram` tool and native window. Install once — this puts
`pi-callflow-mcp` on your PATH (no clone, no build, no absolute paths):

```sh
npm i -g pi-callflow
```

Or skip the install entirely and let the agent run it via `npx` — this **auto-updates**, since
`@latest` re-fetches the newest published version every time the MCP server launches. Note the
npx target is the **package** name `pi-callflow` (not the bin name `pi-callflow-mcp`):

```sh
npx -y pi-callflow@latest
```

**Claude Code** — one command (auto-updating):

```sh
claude mcp add callflow -- npx -y pi-callflow@latest
```

**Codex** — add to `~/.codex/config.toml` (auto-updating):

```toml
[mcp_servers.callflow]
command = "npx"
args = ["-y", "pi-callflow@latest"]
```

(Prefer a pinned global binary instead? Run `npm i -g pi-callflow`, then use
`command = "pi-callflow-mcp"` — that bin name is only valid on your PATH after a global install,
not as an `npx` target. On startup the server checks the registry once and logs a one-line
notice to stderr when a newer version is out; set `CALLFLOW_NO_UPDATE_CHECK=1` to silence it.)

That's it. Then ask the agent in plain language:

```text
show the call flow from the /login endpoint
```

The agent analyzes the code, calls the `render_call_diagram` tool, and the window opens as
soon as the tool is called.

<details>
<summary>From a local clone (absolute path)</summary>

If you cloned the repo instead of installing globally (`git clone` +
`npm install` builds `dist/mcp-server.mjs`), point at it directly:

```sh
claude mcp add callflow -- node /Users/you/dev/pi-callflow/dist/mcp-server.mjs
```
```toml
# ~/.codex/config.toml
[mcp_servers.callflow]
command = "node"
args = ["/Users/you/dev/pi-callflow/dist/mcp-server.mjs"]
```
</details>

**Set the repo root** so `file:line` clicks resolve correctly (defaults to the server's
working directory). Add an `env` to the config:

```toml
[mcp_servers.callflow]
command = "npx"
args = ["-y", "pi-callflow@latest"]
env = { CALLFLOW_CWD = "/Users/you/dev/your-project" }
```

Notes for MCP:
- The server logs only to **stderr** (stdout is the protocol channel).
- MCP has no "turn end" event, so the window opens **immediately** on the tool call rather
  than when the agent finishes (that timing difference is the only behavioral gap vs pi).

## Editor jump

Clicking a step opens the file in your editor. The top bar shows an **“open in” selector**
listing only the editors actually installed on your machine (detected via `command -v`):
VS Code, Cursor, IntelliJ IDEA, Sublime. Pick one; clicks use it.

To force a specific command (and lock the selector), set an env override:

```sh
export CALLFLOW_OPEN_CMD='idea --line {line} {file}'   # IntelliJ
export CALLFLOW_OPEN_CMD='code -g {file}:{line}'        # VS Code
```

## Linux / WSL

The native Glimpse window needs a GUI. On plain Linux, install the GTK4 / WebKitGTK dev
packages so the native window can build and launch; otherwise the viewer falls back to your
system browser via `xdg-open`.

**WSL (WSL2 on Windows)** is a common gotcha: there's usually no working `xdg-open`, so the
fallback silently does nothing and *no window appears*. callflow now detects WSL and opens the
diagram in your **Windows default browser** automatically, using either:

- [`wslview`](https://github.com/wslutilities/wslu) if installed (recommended), or
- `explorer.exe` with a translated Windows path as a fallback.

So the smoothest setup on WSL is to install `wslu`:

```sh
sudo apt install wslu          # Debian/Ubuntu — provides wslview
```

Want the *real native window* on WSL instead of the browser? You need **WSLg** (bundled with
Windows 11 and recent Windows 10) plus the GTK4/WebKit toolchain so glimpseui can build its
native binary. If that's not available, the Windows-browser fallback above is the practical
path.

Either way, you can force a specific opener with an env override (handy for a non-default
browser, or any custom launcher). Use `{file}` for the HTML path (it's appended if omitted):

```sh
export CALLFLOW_BROWSER='wslview {file}'
export CALLFLOW_BROWSER='/mnt/c/Program Files/Google/Chrome/Application/chrome.exe'
```

## Offline / closed networks

The viewer HTML is fully self-contained: `mermaid` is bundled inline at build time (no CDN),
so it renders identically on air-gapped / corporate networks. If the native Glimpse window
can't launch (no toolchain), it falls back to opening the diagram in the system browser.

## Develop

```sh
npm install
npm run build        # build:web (esbuild → self-contained web/dist/index.html) + tsc check
npm run smoke        # opens the real window with a sample diagram, auto-closes in 4s
```

After editing `web/src/*`, re-run `npm run build:web`.

## Status

MVP. See [HANDOFF.md](./HANDOFF.md) for the full design record, decisions, and roadmap.
