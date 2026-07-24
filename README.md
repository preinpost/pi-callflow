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

Install in one line (prebuilt viewer + MCP server ship in the package — no local build):

```sh
npm i -g pi-callflow
```

Load the extension in your project and ask for a flow (point `-e` at the globally installed
package, or clone the repo if you prefer a local checkout):

```sh
cd ~/dev/your-project && pi -e pi-callflow
```
```text
/callflow "show the call flow from the /auth/authorize endpoint"
#  → agent analyzes the code, then the window opens with the result.

/callflow                      # (no arg) just open an empty viewer
```

In pi the window opens **when the agent finishes** the turn. Asking in plain language also
works — if the agent calls the tool, the window still opens at the end of the turn.

### Option B — with Claude Code / Codex (MCP)

The same viewer is a local **stdio MCP server**, so teammates on Claude Code or Codex get the
identical `render_call_diagram` tool and native window. Install once — this puts
`pi-callflow-mcp` on your PATH (no clone, no build, no absolute paths):

```sh
npm i -g pi-callflow
```

Or skip the install entirely and let the agent run it via `npx`:

```sh
npx -y pi-callflow-mcp
```

**Claude Code** — one command:

```sh
claude mcp add callflow -- pi-callflow-mcp
```

**Codex** — add to `~/.codex/config.toml`:

```toml
[mcp_servers.callflow]
command = "pi-callflow-mcp"
```

That's it. Then ask the agent *"show the call flow from /auth/authorize"* and the window
opens as soon as the tool is called.

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
command = "pi-callflow-mcp"
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
