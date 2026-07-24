import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CallflowController, type Notify } from "../core/controller.js";
import {
  buildFlowchart,
  buildSequenceDiagram,
  type FlowchartNode,
  type FlowchartSubgraph,
} from "../core/mermaid.js";
import type { CallStep, Diagram } from "../core/types.js";

const MERMAID_SPECIAL_RE = /[()<>;]/;

function leadingSpaces(line: string): string {
  const match = line.match(/^\s*/);
  return match ? match[0] : "";
}

function needsMermaidQuote(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return false;
  return MERMAID_SPECIAL_RE.test(value);
}

function escapeMermaidSemicolons(value: string): string {
  // Mermaid uses ';' as a statement separator in sequence messages, even inside quoted text.
  // Use the Mermaid HTML-entity form '#59;' for a literal semicolon.
  // Avoid double-escaping an already-formed entity like '#59;' or '&#59;'.
  return value.replace(/(?<!&#?\d+);/g, "#59;");
}

function mermaidQuote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed;
  // Escape inner double quotes and semicolons so they do not break the quoted Mermaid string.
  const escaped = value
    .replace(/"/g, "#quot;")
    .replace(/(?<!&#?\d+);/g, "#59;");
  return `"${escaped}"`;
}

/** Make a Mermaid sequenceDiagram source safe for the parser.
 *  Participant aliases and message texts that contain parentheses, angle brackets,
 *  or semicolons
 *  are wrapped in double quotes, which Mermaid treats as literal strings.
 */
function sanitizeMermaidSequence(sequence: string): string {
  return sequence
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();

      // Participant aliases: participant ID as Label
      const participantMatch = trimmed.match(/^participant\s+(\S+)\s+as\s+(.+)$/i);
      if (participantMatch) {
        const id = participantMatch[1];
        const label = participantMatch[2].trim();
        if (needsMermaidQuote(label)) {
          return `${leadingSpaces(line)}participant ${id} as ${mermaidQuote(label)}`;
        }
        return line;
      }

      // Message lines: A->B: text
      const msgMatch = trimmed.match(/^(\S+?)([-.=~]+(?:>>?>?)?[xox]?)(\S+?)\s*:\s+(.*)$/);
      if (msgMatch) {
        const from = msgMatch[1];
        const arrow = msgMatch[2];
        const to = msgMatch[3];
        const text = msgMatch[4].trim();
        if (needsMermaidQuote(text)) {
          return `${leadingSpaces(line)}${from}${arrow}${to}: ${mermaidQuote(text)}`;
        }
      }

      return line;
    })
    .join("\n");
}

const StepSchema = Type.Object({
  from: Type.String({ description: "Caller participant id (must match a participant id)" }),
  to: Type.String({ description: "Callee participant id (must match a participant id)" }),
  call: Type.String({ description: "Method/endpoint invoked, e.g. grant()" }),
  file: Type.String({ description: "Source file path (repo-relative), REQUIRED for grounding" }),
  line: Type.Number({ description: "1-based line number where this call originates, REQUIRED" }),
  note: Type.Optional(Type.String({ description: "Short clarification rendered as a Note over the two participants" })),
  kind: Type.Optional(
    Type.Union([Type.Literal("request"), Type.Literal("response")], {
      description: "Arrow style: request (->>) or response (-->>). Defaults to request.",
    }),
  ),
});

const ParticipantSchema = Type.Object({
  id: Type.String({ description: "Short participant id used in step from/to fields" }),
  label: Type.String({ description: "Display label, may contain file paths or <br/>" }),
});

const NoteSchema = Type.Object({
  position: Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("over")]),
  participants: Type.Array(Type.String()),
  text: Type.String(),
});

const GroupItemSchema = Type.Union([
  Type.Object({
    type: Type.Literal("message"),
    from: Type.String(),
    to: Type.String(),
    text: Type.String(),
  }),
  Type.Object({
    type: Type.Literal("note"),
    position: Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("over")]),
    participants: Type.Array(Type.String()),
    text: Type.String(),
  }),
  Type.Object({
    type: Type.Literal("else"),
    label: Type.Optional(Type.String()),
  }),
]);

const GroupSchema = Type.Object({
  keyword: Type.Union([Type.Literal("alt"), Type.Literal("opt"), Type.Literal("loop"), Type.Literal("par"), Type.Literal("rect")]),
  label: Type.Optional(Type.String()),
  items: Type.Array(GroupItemSchema),
});

const FlowchartNodeSchema = Type.Object({
  id: Type.String({ description: "Short node id used in edges (alphanumeric/underscore recommended)" }),
  label: Type.String({ description: "Display label" }),
  shape: Type.Optional(
    Type.Union(
      [
        Type.Literal("default"),
        Type.Literal("round"),
        Type.Literal("stadium"),
        Type.Literal("subprocess"),
        Type.Literal("cylinder"),
        Type.Literal("circle"),
        Type.Literal("diamond"),
      ],
      { description: "Mermaid flowchart node shape", default: "default" },
    ),
  ),
});

const FlowchartEdgeSchema = Type.Object({
  from: Type.String({ description: "Source node id" }),
  to: Type.String({ description: "Target node id" }),
  label: Type.Optional(Type.String({ description: "Edge label" })),
});

const FlowchartSubgraphSchema = Type.Object({
  label: Type.String(),
  direction: Type.Optional(Type.Union([Type.Literal("TB"), Type.Literal("TD"), Type.Literal("LR"), Type.Literal("RL")])),
  nodes: Type.Array(FlowchartNodeSchema),
  edges: Type.Array(FlowchartEdgeSchema),
});

const RenderParams = Type.Object({
  title: Type.String({ description: "Short title, e.g. 'Login → OTP verification flow'" }),
  sequence: Type.Optional(
    Type.String({
      description:
        "DEPRECATED. Provide 'participants' and 'steps' instead. Optional raw Mermaid 'sequenceDiagram' source, used only as an override.",
    }),
  ),
  participants: Type.Optional(
    Type.Array(ParticipantSchema, {
      description:
        "Participant aliases. The 'id' is used in step from/to fields; the 'label' is the display text shown in the diagram.",
    }),
  ),
  notes: Type.Optional(Type.Array(NoteSchema, { description: "Stand-alone Mermaid notes." })),
  groups: Type.Optional(Type.Array(GroupSchema, { description: "Grouping blocks: alt/opt/loop/par/rect." })),
  flowchart: Type.Optional(
    Type.String({
      description:
        "DEPRECATED. Provide 'flowchartNodes', 'flowchartEdges', and optionally 'flowchartSubgraphs' instead. Optional raw Mermaid 'flowchart TD' source, used only as an override.",
    }),
  ),
  flowchartDirection: Type.Optional(
    Type.Union([Type.Literal("TB"), Type.Literal("TD"), Type.Literal("LR"), Type.Literal("RL")], {
      description: "Flowchart direction",
      default: "TD",
    }),
  ),
  flowchartNodes: Type.Optional(Type.Array(FlowchartNodeSchema, { description: "Flowchart nodes" })),
  flowchartEdges: Type.Optional(Type.Array(FlowchartEdgeSchema, { description: "Flowchart edges" })),
  flowchartSubgraphs: Type.Optional(Type.Array(FlowchartSubgraphSchema, { description: "Flowchart subgraphs" })),
  steps: Type.Array(StepSchema, {
    description:
      "Ordered call steps. EVERY step must carry a real file:line you actually read. Do not invent sources; if you cannot ground a step, omit it or inspect the code first.",
  }),
  contextNotes: Type.Optional(Type.String({ description: "Optional context: branches, config keys, edge cases" })),
});

function toDiagram(params: {
  title: string;
  sequence: string;
  flowchart?: string;
  steps: Array<Omit<CallStep, "index">>;
  notes?: string;
}): Diagram {
  return {
    title: params.title,
    sequence: params.sequence,
    flowchart: params.flowchart,
    steps: params.steps.map((s, i) => ({ ...s, index: i + 1 })),
    notes: params.notes,
    generatedAt: Date.now(),
  };
}

function renderFlowchart(params: {
  flowchart?: string;
  direction?: "TB" | "TD" | "LR" | "RL";
  nodes?: Array<{ id: string; label: string; shape?: string }>;
  edges?: Array<{ from: string; to: string; label?: string }>;
  subgraphs?: Array<{ label: string; direction?: "TB" | "TD" | "LR" | "RL"; nodes: any[]; edges: any[] }>;
}): string | undefined {
  if (params.flowchart) return sanitizeMermaidFlowchart(params.flowchart);
  if (!params.nodes || params.nodes.length === 0) return undefined;
  return buildFlowchart({
    direction: params.direction,
    nodes: params.nodes as FlowchartNode[],
    edges: params.edges ?? [],
    subgraphs: params.subgraphs as FlowchartSubgraph[] | undefined,
  });
}

function sanitizeMermaidFlowchart(flowchart: string): string {
  // Minimal sanitizer for legacy raw flowchart input.
  // Node labels and edge labels are the most common failure points.
  return flowchart
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      // Node definition: id["label"] or id("label") etc. Ensure labels are quoted.
      const nodeMatch = trimmed.match(/^(\S+)\s*([\[(\{]+)\s*([^\]\)\}]+)\s*([\]\)\}]+)$/);
      if (nodeMatch) {
        const id = nodeMatch[1];
        const open = nodeMatch[2];
        const label = nodeMatch[3].trim();
        const close = nodeMatch[4];
        if (!/^".*"$/.test(label)) {
          return `${id}${open}${mermaidQuote(label)}${close}`;
        }
      }
      return line;
    })
    .join("\n");
}

function renderSequence(params: {
  sequence?: string;
  participants?: Array<{ id: string; label: string }>;
  steps: Array<{ from: string; to: string; call: string; note?: string; kind?: "request" | "response" }>;
  notes?: Array<{ position: "left" | "right" | "over"; participants: string[]; text: string }>;
  groups?: Array<{
    keyword: "alt" | "opt" | "loop" | "par" | "rect";
    label?: string;
    items: Array<
      | { type: "message"; from: string; to: string; text: string }
      | { type: "note"; position: "left" | "right" | "over"; participants: string[]; text: string }
      | { type: "else"; label?: string }
    >;
  }>;
}): string {
  if (params.sequence) return sanitizeMermaidSequence(params.sequence);
  return buildSequenceDiagram({
    participants: params.participants,
    steps: params.steps,
    notes: params.notes,
    groups: params.groups,
  });
}

function buildCallflowPrompt(question: string): string {
  return (
    `${question.trim()}\n\n` +
    `(Call-flow request: inspect the ACTUAL code paths first, then call render_call_diagram. ` +
    `Provide 'participants' (id + label) and 'steps' (from/to id, call text, file, line). ` +
    `The sequence diagram is generated automatically, so do NOT write raw Mermaid unless necessary. ` +
    `Also provide 'flowchartNodes' and 'flowchartEdges' whenever the flow has branching — ` +
    `it is shown collapsed under the sequence. Every step MUST cite a real file:line you read. ` +
    `The window opens automatically once you finish.)`
  );
}

export default function callflow(pi: ExtensionAPI) {
  let controller: CallflowController | null = null;
  // Diagram produced during the current turn; shown when the agent finishes (agent_end).
  let pending: Diagram | null = null;

  const getController = (cwd: string, notify: Notify): CallflowController => {
    if (controller == null) {
      controller = new CallflowController(cwd, notify, () => {
        controller = null;
      });
    }
    return controller;
  };

  pi.registerTool({
    name: "render_call_diagram",
    label: "Call Flow",
    description:
      "Stage a call-structure diagram to be shown in the Call Flow window when the current turn finishes. " +
      "Use when the user asks to see how a request/endpoint/feature flows through the code. " +
      "Provide 'participants' and 'steps'; the sequence diagram is generated automatically. " +
      "Only provide 'sequence' as a raw Mermaid override when automatic generation cannot express the layout. " +
      "Also fill 'flowchart' with a Mermaid 'flowchart TD' when the flow has branching — it renders in a " +
      "collapsible section under the sequence. First inspect the actual code, then call this with a diagram " +
      "whose every step cites a real file:line. Calling again in the same turn replaces the staged diagram.",
    promptSnippet:
      "render_call_diagram — stage a code call flow (sequence + optional collapsible flowchart) with file:line grounding; shown when the turn ends.",
    promptGuidelines: [
      "When the user asks to see a call/execution structure, inspect the real code first, then call render_call_diagram.",
      "Provide 'participants' (short id + display label) and 'steps' (from/to ids, call text, file, line). The tool builds the Mermaid sequence diagram for you.",
      "Only use the 'sequence' field as a manual override when the automatic layout is insufficient; it will be sanitized, not used verbatim.",
      "For branching/decision logic, provide 'flowchartNodes', 'flowchartEdges', and optionally 'flowchartSubgraphs'. The tool builds the flowchart for you. Only use 'flowchart' as a manual override.",
      "Every step in render_call_diagram MUST include the actual file and line you read; never fabricate sources.",
    ],
    parameters: RenderParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx: ExtensionContext) {
      const sequence = renderSequence({
        sequence: params.sequence,
        participants: params.participants,
        steps: params.steps,
        notes: params.notes,
        groups: params.groups,
      });
      const flowchart = renderFlowchart({
        flowchart: params.flowchart,
        direction: params.flowchartDirection,
        nodes: params.flowchartNodes,
        edges: params.flowchartEdges,
        subgraphs: params.flowchartSubgraphs,
      });
      const diagram = toDiagram({
        title: params.title,
        sequence,
        flowchart,
        steps: params.steps,
        notes: params.contextNotes,
      });
      pending = diagram; // buffer; the window opens at agent_end
      const stepLines = diagram.steps
        .map((s) => `${s.index}. ${s.from} → ${s.to} : ${s.call}  (${s.file}:${s.line})`)
        .join("\n");
      const kinds = diagram.flowchart ? "sequence + flowchart" : "sequence";
      return {
        content: [
          {
            type: "text",
            text: `Staged "${diagram.title}" (${kinds}) with ${diagram.steps.length} grounded step(s). It will open in the Call Flow window when this turn finishes.\n${stepLines}`,
          },
        ],
        details: null,
      };
    },
  });

  // When the agent job finishes, reveal the staged diagram in the window.
  pi.on("agent_end", async (_event, ctx: ExtensionContext) => {
    if (pending == null) return;
    const diagram = pending;
    pending = null;
    if (ctx.mode !== "tui") return; // no window surface outside interactive mode
    const notify: Notify = (m, l) => ctx.ui?.notify?.(m, l);
    try {
      getController(ctx.cwd, notify).render(diagram);
    } catch (error) {
      notify(`Could not open Call Flow window: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });

  // /callflow "question"  → run analysis, show window when done.
  // /callflow             → just open (or focus) the viewer.
  pi.registerCommand("callflow", {
    description: 'Ask for a call flow: /callflow "how does login work" (window opens when the agent finishes)',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Call Flow requires interactive TUI mode.", "warning");
        return;
      }
      const question = stripQuotes(args.trim());
      if (question.length === 0) {
        const notify: Notify = (m, l) => ctx.ui.notify(m, l);
        getController(ctx.cwd, notify).ensureOpen();
        ctx.ui.notify('Call Flow window opened. Try: /callflow "how does the /auth/authorize flow work"', "info");
        return;
      }
      pi.sendUserMessage(buildCallflowPrompt(question));
      ctx.ui.notify("Analyzing… the Call Flow window will open when the agent finishes.", "info");
    },
  });

  pi.on("session_shutdown", async () => {
    const active = controller;
    controller = null;
    pending = null;
    active?.close();
  });
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
    return value.slice(1, -1);
  }
  return value;
}
