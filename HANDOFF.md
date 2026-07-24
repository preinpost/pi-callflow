# HANDOFF — pi-callflow

> Purpose of this doc: let anyone (human or agent) pick up this project cold. It records
> **why** each decision was made (from a grilling session), **what** exists now, **how** it
> was verified, and **what's left**.

Last updated: 2026-07-24 · Status: **MVP working, end-to-end verified**

---

## 1. What this is

An on-demand call-structure visualizer for [pi](https://pi.dev). The user is onboarding onto
`/Users/ms/dev/i/openstackit-java` (multi-module Java, ~3,514 `.java` files) and wants to ask
the agent *"show the call structure starting from login / this endpoint"* and see a
**diagram** (call order) instead of terminal text.

Reference for the desired analysis depth: a teammate's Confluence page "OTP 인증"
(sequence flows like `check → token → grant → SUCCESS`, case tables, code references such as
`AuthController.java` / `otpService.verifyOTPCode()`).

---

## 2. Decisions (from the grilling session)

| # | Question | Decision | Why |
|---|----------|----------|-----|
| Q1–3 | Role of Glimpse | **Result viewer / live preview** during analysis (not a wiki publisher, not a control surface) | Real bottleneck is reading flows as text; a rich live view speeds understanding |
| Q4 | Diagram type | **Mermaid sequence (primary) + flowchart (secondary)** | "Call order" is inherently temporal → sequence fits; both are free in Mermaid |
| Q5 | UX model | **Persistent window** (diff-review style, stays open & updates) | User explicitly liked `pi-review-loop`'s "git-client, see-changes-immediately" feel |
| Q6 | Delivery layer | **pi custom tool `render_call_diagram` (first-class)** + `/callflow` command; MCP later | User wants first-class pi; Claude Code/Codex compat is secondary (teammates may not use it) |
| Q7 | Window lifecycle | **One window per session**; closes on `session_shutdown` | Onboarding = one project at a time; simplest, clean teardown |
| Q8 | Accuracy / trust | **Grounding-lite**: every step MUST carry `file:line` | Pure-LLM tracing on a 3.5k-file repo hallucinates; hard static parsing (LSP) is over-budget |
| Q9 | Window content | Diagram + **step panel** (`from → to : call` + `file:line`) + **click-to-open editor** | Closes the loop "diagram → click → real code" |
| Q9b | Editor | **Selectable** (VS Code / IntelliJ / custom) via `CALLFLOW_OPEN_CMD` | Team uses both `code` and `idea` |
| Q10 | Rendering | **Mermaid bundled inline** (self-contained HTML, no CDN) | Team distribution + offline/closed-net must never show a blank window |
| Q11 | Export | Deferred (nice-to-have Copy Mermaid / Export Markdown) | Original intent is analysis, not wiki publishing |
| Q12 | Scope | **MVP first** (thin end-to-end slice) | De-risk plumbing before adding polish |
| Q13 | Interaction model | **`/callflow "question"` triggers the turn; window opens on `agent_end`** (not mid-stream) | User wants a clear command entry and to see the *finished* diagram after the job completes |

**Cross-tool note:** The true common denominator for pi + Claude Code + Codex is a **local
stdio MCP server** (all three spawn it as a local child process, so it *can* open a local
GUI window). That path is intentionally deferred; the core is factored so an MCP wrapper is
~50 lines when wanted.

---

## 3. Architecture

Core is host-agnostic; adapters are thin.

```
src/
  core/
    types.ts        # Diagram, CallStep, Host/Window message types
    controller.ts   # CallflowController: singleton Glimpse window, browser fallback, editor jump
    ui.ts           # loadCallflowHtml() — reads the built self-contained HTML
  pi/
    index.ts        # [1st-class] registerTool('render_call_diagram') + /callflow + session_shutdown
  mcp/
    server.ts       # [cross-tool] thin stdio-MCP wrapper over core; bundled to dist/mcp-server.mjs
dist/
  mcp-server.mjs    # BUILT: runnable stdio MCP server (bin: pi-callflow-mcp)
web/
  src/app.ts        # mermaid render + step panel + host<->web messaging
  src/index.html    # template (placeholders inlined at build)
  src/styles.css
  dist/index.html   # BUILT: self-contained, mermaid inlined (~3.3 MB)
scripts/
  build-web.mjs     # esbuild bundle app+mermaid → inline into single index.html
  smoke.mjs         # standalone end-to-end window test (auto-closes 4s)
```

### Interaction flow (Q13)
1. `/callflow "how does login work"` → command calls `pi.sendUserMessage(question + grounding hint)`, which **always triggers a turn**. No window yet.
2. Agent inspects code → calls `render_call_diagram` → the tool **buffers** the diagram into `pending` (does NOT open the window).
3. `pi.on("agent_end")` → if `pending` is set, open/refresh the window and render it, then clear `pending`.

Asking in plain language also works: any turn where the agent calls the tool shows the window at `agent_end`. `/callflow` with no arg just `ensureOpen()`s an empty viewer.

Key APIs used: `pi.sendUserMessage()` (auto-runs a turn), `pi.on("agent_end", (e, ctx) => ...)` (ctx gives `cwd` + `ui.notify`).

### Message protocol
- **host → web:** `window.send("window.__callflowReceive(<json>)")` with `{type:"diagram"|"empty"}`
- **web → host:** `glimpse.send({type:"ready"})` on load; `{type:"open-file",file,line}` on step click

### Tool schema (the grounding contract)
```
render_call_diagram({
  title: string,
  sequence: string,                                  // Mermaid 'sequenceDiagram' (REQUIRED, primary)
  flowchart?: string,                                // Mermaid 'flowchart TD' (optional, collapsible)
  steps: [{ from, to, call, file, line, note? }],    // file & line REQUIRED per step
  notes?: string
})
```
The viewer shows the result in **tabs** (top-left): a **Sequence** tab (default) and a
**Flowchart** tab (hidden when no flowchart is provided). Each stage is a **zoom/pan surface**
(wheel = zoom at cursor, drag = pan, +/−/⌗ buttons, double-click = fit; natural size derived
from the SVG `viewBox`) so large diagrams stay readable. Switching tabs refits the shown stage.

### Key runtime behaviors
- **Editor picker**: controller detects installed editors at construction (`command -v <cmd>`), offers only those in the top-bar `<select>`; selection stored in `selectedEditor` and used by `openInEditor`. Also a top-bar **✕ close** button (web → host `{type:"close"}` → `window.close()` → natural `closed` cleanup).
- **Singleton window** per session; opens on `agent_end` when a diagram was staged. Diagrams accumulate in a **history stack** (`history[]` + `cursor`); prev/next navigates it; a new diagram after navigating back truncates forward entries (browser-style). Nav messages: web → host `{type:"navigate",direction}`; host → web `{type:"diagram",diagram,index,total}`.
- **Browser fallback**: if `open()` from glimpseui throws (no native toolchain), the diagram
  is baked into a temp HTML (`window.__CALLFLOW_BOOT__`) and opened with the OS opener.
- **Editor jump**: `CALLFLOW_OPEN_CMD` template (`{file}`,`{line}`) or default `code -g file:line`.

---

## 4. Current status — what works

- ✅ `npm install` (note: install scripts for `esbuild` + `glimpseui` were approved)
- ✅ `npm run build:web` → self-contained `web/dist/index.html` (mermaid inlined, `</script>` escaped)
- ✅ `npm run check` (tsc) passes clean
- ✅ `npm run smoke` → **native Glimpse window opened, rendered the sample sequence diagram +
  step panel, closed cleanly** ("smoke ok") on this machine (macOS, swiftc present)
- ✅ Env verified: Node v26.4.0, Xcode/swiftc present, `code` + `idea` CLIs present

---

## 5. How to run it in anger

```sh
cd ~/dev/pi-callflow && npm install && npm run build
cd ~/dev/i/openstackit-java && pi -e ~/dev/pi-callflow
# in pi:
/callflow
"show the call structure starting from the /auth/authorize endpoint"
```

---

## 6. Remaining work (roadmap)

**Deferred from MVP (design agreed, not yet built):**
- [x] Sequence **and** flowchart in one payload (`sequence` + optional `flowchart`), shown as **tabs** (Sequence default). **Done.**
- [x] Zoom/pan per diagram (wheel-at-cursor, drag, buttons, double-click fit). **Done.**
- [ ] Export buttons: **Copy Mermaid** / **Export Markdown** (steps table incl. file:line) for
      pasting into Confluence.
- [x] In-window editor selector — top-bar dropdown listing only editors found on PATH (`command -v` / `where`): VS Code, Cursor, IntelliJ, Sublime. `CALLFLOW_OPEN_CMD` overrides and locks it. **Done.** (Not yet persisted across sessions — defaults to first available each open.)
- [x] Diagram history / back-forward within the window (prev/next + counter, browser-style truncation). **Done.**

**Cross-tool (secondary):**
- [x] `src/mcp/server.ts`: stdio MCP server exposing `render_call_diagram` over the same core,
      for Claude Code / Codex teammates. **Done** — built to `dist/mcp-server.mjs` (esbuild,
      glimpseui external), verified end-to-end with the MCP SDK client (`npm run smoke:mcp`).
      Logs to stderr only; window opens immediately on tool call (no `agent_end` in MCP).
- [ ] Verify Codex sandbox actually allows local GUI spawn on teammates' machines.
- [ ] Publish to npm so `npx pi-callflow-mcp` works without an absolute path.

**Hardening:**
- [ ] Consider grounding-*hard* assist: optional ripgrep/LSP pass to suggest/verify call
      targets before the agent draws (raises accuracy on big Java repos).
- [ ] Validate `file:line` against the working tree in the tool (warn on nonexistent paths).
- [ ] Tests for `build-web.mjs` closing-tag escaping and controller message handling.

---

## 7. Gotchas / notes for the next person

- **`web/dist/index.html` is generated** — edit `web/src/*` then `npm run build:web`. `app.js`
  is gitignored; `index.html` is shipped (in `package.json` `files`).
- **Install scripts are gated** in this environment. If `esbuild`/`glimpseui` binaries are
  missing after `npm install`, run `npm approve-scripts esbuild glimpseui` (or the equivalent).
- **Glimpse native window** needs a platform toolchain (macOS: Xcode CLT / swiftc). Teammates
  without it get the **browser fallback** automatically — don't remove that path.
- **Do not** let the agent emit steps without `file:line`; that's the whole trust model. The
  tool description + `promptGuidelines` enforce it, but review generated diagrams.
- Patterns were mirrored from `pi-review-loop`
  (`~/.pi/agent/git/github.com/earendil-works/pi-review-loop`) — the canonical example of a
  persistent Glimpse-backed pi extension.
