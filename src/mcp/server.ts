import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CallflowController, type Notify } from "../core/controller.js";
import type { CallStep, Diagram } from "../core/types.js";

// Injected at build time from package.json (see scripts/build-mcp.mjs).
declare const __PKG_NAME__: string;
declare const __PKG_VERSION__: string;
const PKG_NAME = typeof __PKG_NAME__ === "string" ? __PKG_NAME__ : "pi-callflow";
const PKG_VERSION = typeof __PKG_VERSION__ === "string" ? __PKG_VERSION__ : "0.0.0";

// IMPORTANT: stdout is the MCP protocol channel. Never write logs to stdout.
const notify: Notify = (message, level) => {
  process.stderr.write(`[callflow:${level}] ${message}\n`);
};

// Best-effort update check. Never blocks startup, never throws, stderr only.
// Disable with CALLFLOW_NO_UPDATE_CHECK=1.
function cmpSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

async function checkForUpdate(): Promise<void> {
  if (process.env.CALLFLOW_NO_UPDATE_CHECK === "1") return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`https://registry.npmjs.org/${PKG_NAME}/latest`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return;
    const latest = (await res.json())?.version;
    if (typeof latest === "string" && cmpSemver(latest, PKG_VERSION) > 0) {
      notify(
        `Update available: ${PKG_NAME} ${PKG_VERSION} → ${latest}. ` +
          `Run 'npm i -g ${PKG_NAME}@latest', or use 'npx -y ${PKG_NAME}@latest' in your MCP config to always launch the newest.`,
        "info",
      );
    }
  } catch {
    /* offline / air-gapped / registry blocked — ignore */
  }
}

// The MCP server owns one persistent viewer for its lifetime.
const cwd = process.env.CALLFLOW_CWD || process.cwd();
let controller: CallflowController | null = null;
const getController = (): CallflowController => {
  if (controller == null) {
    controller = new CallflowController(cwd, notify, () => {
      controller = null;
    });
  }
  return controller;
};

const StepShape = {
  from: z.string().describe("Caller participant (class/component/actor)"),
  to: z.string().describe("Callee participant"),
  call: z.string().describe("Method/endpoint invoked, e.g. grant()"),
  file: z.string().describe("Source file path (repo-relative), REQUIRED for grounding"),
  line: z.number().describe("1-based line number where this call originates, REQUIRED"),
  note: z.string().optional().describe("Short clarification (branch/condition)"),
};

const inputSchema = {
  title: z.string().describe("Short title, e.g. 'Login → OTP verification flow'"),
  sequence: z
    .string()
    .describe("REQUIRED. Mermaid 'sequenceDiagram' source showing call ordering. Must reflect the real code you inspected."),
  flowchart: z
    .string()
    .optional()
    .describe("Mermaid 'flowchart TD' source for branch/decision logic. Provide it whenever the flow has meaningful branching; it renders in a separate Flowchart tab next to the sequence."),
  steps: z
    .array(z.object(StepShape))
    .describe("Ordered call steps. EVERY step must carry a real file:line you actually read. Do not fabricate sources."),
  notes: z.string().optional().describe("Optional context: branches, config keys, edge cases"),
};

function toDiagram(args: {
  title: string;
  sequence: string;
  flowchart?: string;
  steps: Array<Omit<CallStep, "index">>;
  notes?: string;
}): Diagram {
  return {
    title: args.title,
    sequence: args.sequence,
    flowchart: args.flowchart,
    steps: args.steps.map((s, i) => ({ ...s, index: i + 1 })),
    notes: args.notes,
    generatedAt: Date.now(),
  };
}

async function main(): Promise<void> {
  const server = new McpServer({ name: PKG_NAME, version: PKG_VERSION });

  server.registerTool(
    "render_call_diagram",
    {
      title: "Render call diagram",
      description:
        "Render a call-structure diagram in a native Call Flow window. Use when the user asks to see how a " +
        "request/endpoint/feature flows through the code. ALWAYS fill 'sequence' with a Mermaid 'sequenceDiagram' " +
        "(call ordering) — it is the default view. ALSO fill 'flowchart' with a Mermaid 'flowchart TD' whenever the " +
        "flow has branching/decisions — it renders in a separate Flowchart tab. Inspect the actual code first, then " +
        "call this with a diagram whose every step cites a real file:line.",
      inputSchema,
    },
    async (args) => {
      const diagram = toDiagram(args);
      try {
        getController().render(diagram);
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to render diagram: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
      const stepLines = diagram.steps
        .map((s) => `${s.index}. ${s.from} → ${s.to} : ${s.call}  (${s.file}:${s.line})`)
        .join("\n");
      const kinds = diagram.flowchart ? "sequence + flowchart" : "sequence";
      return {
        content: [
          {
            type: "text",
            text: `Rendered "${diagram.title}" (${kinds}) in the Call Flow window with ${diagram.steps.length} grounded step(s).\n${stepLines}`,
          },
        ],
      };
    },
  );

  const shutdown = () => {
    try { controller?.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  notify(`pi-callflow MCP server ready (stdio), v${PKG_VERSION}.`, "info");
  void checkForUpdate();
}

main().catch((error) => {
  process.stderr.write(`[callflow:fatal] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
