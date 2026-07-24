import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CallflowController, type Notify } from "../core/controller.js";
import type { CallStep, Diagram } from "../core/types.js";

const MERMAID_SPECIAL_RE = /[()<>]/;

function leadingSpaces(line: string): string {
  const match = line.match(/^\s*/);
  return match ? match[0] : "";
}

function needsMermaidQuote(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return false;
  return MERMAID_SPECIAL_RE.test(value);
}

function mermaidQuote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed;
  // Escape inner double quotes so they do not break the quoted Mermaid string.
  return `"${value.replace(/"/g, "#quot;")}"`;
}

/** Make a Mermaid sequenceDiagram source safe for the parser.
 *  Participant aliases and message texts that contain parentheses or angle brackets
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
  from: Type.String({ description: "Caller participant (class/component/actor)" }),
  to: Type.String({ description: "Callee participant" }),
  call: Type.String({ description: "Method/endpoint invoked, e.g. grant()" }),
  file: Type.String({ description: "Source file path (repo-relative), REQUIRED for grounding" }),
  line: Type.Number({ description: "1-based line number where this call originates, REQUIRED" }),
  note: Type.Optional(Type.String({ description: "Short clarification (branch/condition)" })),
});

const RenderParams = Type.Object({
  title: Type.String({ description: "Short title, e.g. 'Login → OTP verification flow'" }),
  sequence: Type.String({
    description:
      "REQUIRED. Mermaid 'sequenceDiagram' source showing the call ordering between participants. Must reflect the real code you inspected.",
  }),
  flowchart: Type.Optional(
    Type.String({
      description:
        "Mermaid 'flowchart TD' source for branch/decision logic. Provide it whenever the flow has meaningful branching; it is shown in a collapsible section under the sequence diagram.",
    }),
  ),
  steps: Type.Array(StepSchema, {
    description:
      "Ordered call steps. EVERY step must carry a real file:line you actually read. Do not invent sources; if you cannot ground a step, omit it or inspect the code first.",
  }),
  notes: Type.Optional(Type.String({ description: "Optional context: branches, config keys, edge cases" })),
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

function buildCallflowPrompt(question: string): string {
  return (
    `${question.trim()}\n\n` +
    `(Call-flow request: inspect the ACTUAL code paths first, then call render_call_diagram. ` +
    `Always provide the 'sequence' field (Mermaid 'sequenceDiagram') showing call ordering. ` +
    `Also provide the 'flowchart' field (Mermaid 'flowchart TD') whenever the flow has branching — ` +
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
      "ALWAYS fill 'sequence' with a Mermaid 'sequenceDiagram' (call ordering). ALSO fill 'flowchart' with a " +
      "Mermaid 'flowchart TD' when the flow has branching — it renders in a collapsible section under the " +
      "sequence. First inspect the actual code, then call this with a diagram whose every step cites a real " +
      "file:line. Calling again in the same turn replaces the staged diagram.",
    promptSnippet:
      "render_call_diagram — stage a code call flow (sequence + optional collapsible flowchart) with file:line grounding; shown when the turn ends.",
    promptGuidelines: [
      "When the user asks to see a call/execution structure, inspect the real code first, then call render_call_diagram.",
      "Always provide 'sequence' (call ordering); also provide 'flowchart' when the flow branches meaningfully.",
      "Every step in render_call_diagram MUST include the actual file and line you read; never fabricate sources.",
      "If a participant label or message text contains parentheses or angle brackets, wrap it in double quotes, e.g. Bot->Bot: \"answerCallbackQuery (early, <15s)\".",
    ],
    parameters: RenderParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx: ExtensionContext) {
      const diagram = toDiagram({
        ...params,
        sequence: sanitizeMermaidSequence(params.sequence),
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
