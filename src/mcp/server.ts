import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CallflowController, type Notify } from "../core/controller.js";
import {
  renderFlowchart,
  renderSequence,
  type FlowchartNode,
  type FlowchartSubgraph,
} from "../core/mermaid.js";
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

const positionSchema = z.enum(["left", "right", "over"]);

const StepSchema = z.object({
  from: z.string().describe("Caller participant id (must match a participant id)"),
  to: z.string().describe("Callee participant id (must match a participant id)"),
  call: z.string().describe("Method/endpoint invoked, e.g. grant()"),
  file: z.string().describe("Source file path (repo-relative), REQUIRED for grounding"),
  line: z.number().describe("1-based line number where this call originates, REQUIRED"),
  note: z.string().optional().describe("Short clarification rendered as a Note over the two participants"),
  kind: z.enum(["request", "response"]).optional().describe("Arrow style: request (->>) or response (-->>). Defaults to request."),
});

const ParticipantSchema = z.object({
  id: z.string().describe("Short participant id used in step from/to fields"),
  label: z.string().describe("Display label, may contain file paths or <br/>"),
});

const NoteSchema = z.object({
  position: positionSchema,
  participants: z.array(z.string()),
  text: z.string(),
});

const GroupItemSchema = z.union([
  z.object({ type: z.literal("message"), from: z.string(), to: z.string(), text: z.string() }),
  z.object({ type: z.literal("note"), position: positionSchema, participants: z.array(z.string()), text: z.string() }),
  z.object({ type: z.literal("else"), label: z.string().optional() }),
]);

const GroupSchema = z.object({
  keyword: z.enum(["alt", "opt", "loop", "par", "rect"]),
  label: z.string().optional(),
  items: z.array(GroupItemSchema),
});

const directionSchema = z.enum(["TB", "TD", "LR", "RL"]);

const FlowchartNodeSchema = z.object({
  id: z.string().describe("Short node id used in edges"),
  label: z.string().describe("Display label"),
  shape: z.enum(["default", "round", "stadium", "subprocess", "cylinder", "circle", "diamond"]).optional(),
});

const FlowchartEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
});

const FlowchartSubgraphSchema = z.object({
  label: z.string(),
  direction: directionSchema.optional(),
  nodes: z.array(FlowchartNodeSchema),
  edges: z.array(FlowchartEdgeSchema),
});

const inputSchema = {
  title: z.string().describe("Short title, e.g. 'Login → OTP verification flow'"),
  sequence: z
    .string()
    .optional()
    .describe("DEPRECATED. Provide 'participants' and 'steps' instead. Optional raw Mermaid 'sequenceDiagram' override."),
  participants: z.array(ParticipantSchema).optional().describe("Participant aliases (id + display label)."),
  notes: z.array(NoteSchema).optional().describe("Stand-alone Mermaid notes."),
  groups: z
    .array(z.union([GroupSchema, GroupItemSchema]))
    .optional()
    .describe("Grouping blocks: alt/opt/loop/par/rect. A stray top-level 'else'/message is tolerated and absorbed into the preceding group."),
  flowchart: z
    .string()
    .optional()
    .describe("DEPRECATED. Provide 'flowchartNodes'/'flowchartEdges' instead. Optional raw Mermaid 'flowchart TD' override."),
  flowchartDirection: directionSchema.optional().describe("Flowchart direction (default TD)."),
  flowchartNodes: z.array(FlowchartNodeSchema).optional().describe("Flowchart nodes."),
  flowchartEdges: z.array(FlowchartEdgeSchema).optional().describe("Flowchart edges."),
  flowchartSubgraphs: z.array(FlowchartSubgraphSchema).optional().describe("Flowchart subgraphs."),
  steps: z
    .array(StepSchema)
    .describe("Ordered call steps. EVERY step must carry a real file:line you actually read. Do not fabricate sources."),
  contextNotes: z.string().optional().describe("Optional context: branches, config keys, edge cases"),
};

type RenderArgs = {
  title: string;
  sequence?: string;
  participants?: Array<{ id: string; label: string }>;
  notes?: Array<{ position: "left" | "right" | "over"; participants: string[]; text: string }>;
  groups?: Parameters<typeof renderSequence>[0]["groups"];
  flowchart?: string;
  flowchartDirection?: "TB" | "TD" | "LR" | "RL";
  flowchartNodes?: FlowchartNode[];
  flowchartEdges?: Array<{ from: string; to: string; label?: string }>;
  flowchartSubgraphs?: FlowchartSubgraph[];
  steps: Array<Omit<CallStep, "index">>;
  contextNotes?: string;
};

function toDiagram(args: RenderArgs): Diagram {
  const sequence = renderSequence({
    sequence: args.sequence,
    participants: args.participants,
    steps: args.steps,
    notes: args.notes,
    groups: args.groups,
  });
  const flowchart = renderFlowchart({
    flowchart: args.flowchart,
    direction: args.flowchartDirection,
    nodes: args.flowchartNodes,
    edges: args.flowchartEdges,
    subgraphs: args.flowchartSubgraphs,
  });
  return {
    title: args.title,
    sequence,
    flowchart,
    steps: args.steps.map((s, i) => ({ ...s, index: i + 1 })),
    notes: args.contextNotes,
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
        "request/endpoint/feature flows through the code. Provide 'participants' and 'steps'; the sequence diagram " +
        "is generated automatically. For branching/decisions, provide 'flowchartNodes'/'flowchartEdges'. Only use raw " +
        "'sequence'/'flowchart' as overrides. Inspect the actual code first; every step must cite a real file:line.",
      inputSchema,
    },
    async (args) => {
      const diagram = toDiagram(args as RenderArgs);
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
