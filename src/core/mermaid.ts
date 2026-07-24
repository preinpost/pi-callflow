/** Helpers to generate Mermaid diagrams from structured data.
 *
 *  This avoids asking the LLM to write Mermaid syntax directly, which keeps
 *  hitting parser edge cases (parentheses, angle brackets, semicolons, etc.).
 */

// ---------------------------------------------------------------------------
// Sequence diagram
// ---------------------------------------------------------------------------

export interface SequenceParticipant {
  id: string;
  label: string;
}

export interface SequenceNote {
  position: "left" | "right" | "over";
  participants: string[];
  text: string;
}

export type SequenceGroupItem =
  | { type: "message"; from: string; to: string; text: string }
  | { type: "note"; position: "left" | "right" | "over"; participants: string[]; text: string }
  | { type: "else"; label?: string };

export interface SequenceGroup {
  keyword: "alt" | "opt" | "loop" | "par" | "rect";
  label?: string;
  items: SequenceGroupItem[];
}

export interface SequenceFromStepsInput {
  /** Optional participant aliases. Any id referenced in steps but not listed here
   *  gets a label equal to its id. */
  participants?: SequenceParticipant[];
  /** Ordered call steps; each becomes a message arrow. */
  steps: Array<{ from: string; to: string; call: string; note?: string; kind?: "request" | "response" }>;
  /** Stand-alone notes. */
  notes?: SequenceNote[];
  /** Grouping blocks (alt/opt/loop/par/rect). */
  groups?: SequenceGroup[];
}

// ---------------------------------------------------------------------------
// Flowchart
// ---------------------------------------------------------------------------

export type FlowchartNodeShape =
  | "default"
  | "round"
  | "stadium"
  | "subprocess"
  | "cylinder"
  | "circle"
  | "diamond";

export interface FlowchartNode {
  id: string;
  label: string;
  shape?: FlowchartNodeShape;
}

export interface FlowchartEdge {
  from: string;
  to: string;
  label?: string;
}

export interface FlowchartSubgraph {
  label: string;
  direction?: "TB" | "TD" | "LR" | "RL";
  nodes: FlowchartNode[];
  edges: FlowchartEdge[];
}

export interface FlowchartInput {
  direction?: "TB" | "TD" | "LR" | "RL";
  nodes: FlowchartNode[];
  edges: FlowchartEdge[];
  subgraphs?: FlowchartSubgraph[];
}

// ---------------------------------------------------------------------------
// Shared escaping
// ---------------------------------------------------------------------------

/** Characters that break Mermaid parsing, even inside quoted text.
 *  Newlines become '<br/>', double quotes become '#quot;', and bare semicolons
 *  become '#59;', while any existing entity terminator (e.g. '#59;', '#quot;',
 *  '&lt;', '&#38;') is left intact. */
function escapeMermaidText(value: string): string {
  return value
    .replace(/\r?\n/g, "<br/>")
    .replace(/"/g, "#quot;")
    .replace(/((?:&#?|#)[a-zA-Z0-9]+;)|;/g, (_match, entity) => entity ?? "#59;");
}

function mermaidQuoted(value: string): string {
  return `"${escapeMermaidText(value)}"`;
}

// ---------------------------------------------------------------------------
// Sequence diagram builder
// ---------------------------------------------------------------------------

function arrowFor(kind: "request" | "response" | undefined): string {
  // request: solid arrow (->>), response: dotted arrow (-->>)
  return kind === "response" ? "-->>" : "->>";
}

function renderMessageLine(
  from: string,
  to: string,
  text: string,
  kind?: "request" | "response",
  indent = "    ",
): string {
  return `${indent}${from}${arrowFor(kind)}${to}: ${mermaidQuoted(text)}`;
}

function renderNoteLine(note: SequenceNote, indent = "    "): string {
  const target = note.position === "over" ? note.participants.join(",") : note.participants[0];
  return `${indent}Note ${note.position} ${target}: ${mermaidQuoted(note.text)}`;
}

function renderGroupItem(item: SequenceGroupItem, indent = "        "): string {
  if (item.type === "message") {
    return renderMessageLine(item.from, item.to, item.text, undefined, indent);
  }
  if (item.type === "note") {
    return renderNoteLine(item, indent);
  }
  // else
  return `    else ${item.label ? mermaidQuoted(item.label) : ""}`;
}

export function buildSequenceDiagram(input: SequenceFromStepsInput): string {
  const lines: string[] = ["sequenceDiagram"];

  // Collect every participant id that appears in the diagram.
  const usedIds = new Set<string>();
  for (const s of input.steps) {
    usedIds.add(s.from);
    usedIds.add(s.to);
  }
  for (const g of input.groups ?? []) {
    for (const item of g.items) {
      if (item.type === "message") {
        usedIds.add(item.from);
        usedIds.add(item.to);
      } else if (item.type === "note") {
        for (const p of item.participants) usedIds.add(p);
      }
    }
  }
  for (const n of input.notes ?? []) {
    for (const p of n.participants) usedIds.add(p);
  }

  const participantMap = new Map<string, string>();
  for (const p of input.participants ?? []) {
    participantMap.set(p.id, p.label);
    usedIds.add(p.id);
  }
  for (const id of usedIds) {
    if (!participantMap.has(id)) participantMap.set(id, id);
  }

  // Stable declaration order: explicit participants first, then others alphabetically.
  const explicitIds = new Set(input.participants?.map((p) => p.id) ?? []);
  const orderedIds = [
    ...(input.participants?.map((p) => p.id) ?? []),
    ...Array.from(usedIds)
      .filter((id) => !explicitIds.has(id))
      .sort(),
  ];
  for (const id of orderedIds) {
    const label = participantMap.get(id) ?? id;
    lines.push(`    participant ${id} as ${mermaidQuoted(label)}`);
  }

  // Render steps as messages, plus per-step notes.
  for (const s of input.steps) {
    lines.push(renderMessageLine(s.from, s.to, s.call, s.kind));
    if (s.note) {
      lines.push(renderNoteLine({ position: "over", participants: [s.from, s.to], text: s.note }));
    }
  }

  // Stand-alone notes.
  for (const n of input.notes ?? []) {
    lines.push(renderNoteLine(n));
  }

  // Grouping blocks.
  for (const g of input.groups ?? []) {
    lines.push(`    ${g.keyword} ${g.label ? mermaidQuoted(g.label) : ""}`);
    for (const item of g.items) {
      lines.push(renderGroupItem(item));
    }
    lines.push("    end");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Flowchart builder
// ---------------------------------------------------------------------------

function renderFlowchartNode(node: FlowchartNode): string {
  const label = mermaidQuoted(node.label);
  switch (node.shape) {
    case "round":
      return `${node.id}(${label})`;
    case "stadium":
      return `${node.id}([${label}])`;
    case "subprocess":
      return `${node.id}[[${label}]]`;
    case "cylinder":
      return `${node.id}[(${label})]`;
    case "circle":
      return `${node.id}((${label}))`;
    case "diamond":
      return `${node.id}{${label}}`;
    case "default":
    default:
      return `${node.id}[${label}]`;
  }
}

function renderFlowchartEdge(edge: FlowchartEdge): string {
  if (edge.label) {
    return `${edge.from} -->|${mermaidQuoted(edge.label)}| ${edge.to}`;
  }
  return `${edge.from} --> ${edge.to}`;
}

function renderFlowchartSubgraph(sub: FlowchartSubgraph, indent = "    "): string {
  const lines: string[] = [`${indent}subgraph ${mermaidQuoted(sub.label)}`];
  const inner = `${indent}    `;
  if (sub.direction) lines.push(`${inner}direction ${sub.direction}`);
  for (const n of sub.nodes) lines.push(`${inner}${renderFlowchartNode(n)}`);
  for (const e of sub.edges) lines.push(`${inner}${renderFlowchartEdge(e)}`);
  lines.push(`${indent}end`);
  return lines.join("\n");
}

export function buildFlowchart(input: FlowchartInput): string {
  const direction = input.direction ?? "TD";
  const lines: string[] = [`flowchart ${direction}`];
  for (const n of input.nodes) lines.push(`    ${renderFlowchartNode(n)}`);
  for (const e of input.edges) lines.push(`    ${renderFlowchartEdge(e)}`);
  for (const s of input.subgraphs ?? []) lines.push(renderFlowchartSubgraph(s));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Legacy raw-string sanitizers (used only when a caller supplies raw Mermaid)
// ---------------------------------------------------------------------------

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

function mermaidQuoteRaw(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed;
  return `"${escapeMermaidText(value)}"`;
}

/** Best-effort escaping for legacy raw Mermaid sequenceDiagram input. */
export function sanitizeMermaidSequence(sequence: string): string {
  return sequence
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();

      const participantMatch = trimmed.match(/^participant\s+(\S+)\s+as\s+(.+)$/i);
      if (participantMatch) {
        const id = participantMatch[1];
        const label = participantMatch[2].trim();
        if (needsMermaidQuote(label)) {
          return `${leadingSpaces(line)}participant ${id} as ${mermaidQuoteRaw(label)}`;
        }
        return line;
      }

      const msgMatch = trimmed.match(/^(\S+?)([-.=~]+(?:>>?>?)?[xox]?)(\S+?)\s*:\s+(.*)$/);
      if (msgMatch) {
        const from = msgMatch[1];
        const arrow = msgMatch[2];
        const to = msgMatch[3];
        const text = msgMatch[4].trim();
        if (needsMermaidQuote(text)) {
          return `${leadingSpaces(line)}${from}${arrow}${to}: ${mermaidQuoteRaw(text)}`;
        }
      }

      return line;
    })
    .join("\n");
}

/** Best-effort escaping for legacy raw Mermaid flowchart input. */
export function sanitizeMermaidFlowchart(flowchart: string): string {
  return flowchart
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      const nodeMatch = trimmed.match(/^(\S+)\s*([[({]+)\s*([^\]\)}]+)\s*([\])}]+)$/);
      if (nodeMatch) {
        const id = nodeMatch[1];
        const open = nodeMatch[2];
        const label = nodeMatch[3].trim();
        const close = nodeMatch[4];
        if (!/^".*"$/.test(label)) {
          return `${leadingSpaces(line)}${id}${open}${mermaidQuoteRaw(label)}${close}`;
        }
      }
      return line;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Group coercion: repair loosely-shaped 'groups' input so it never hard-fails
// ---------------------------------------------------------------------------

const GROUP_KEYWORDS = new Set(["alt", "opt", "loop", "par", "rect"]);

function coerceGroupItem(raw: unknown): SequenceGroupItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.type === "message" && typeof r.from === "string" && typeof r.to === "string") {
    return { type: "message", from: r.from, to: r.to, text: String(r.text ?? "") };
  }
  if (r.type === "note" && Array.isArray(r.participants)) {
    const position = r.position === "left" || r.position === "right" ? r.position : "over";
    return { type: "note", position, participants: r.participants.map(String), text: String(r.text ?? "") };
  }
  if (r.type === "else") {
    return { type: "else", label: r.label != null ? String(r.label) : undefined };
  }
  return null;
}

/** Normalize a loosely-shaped groups array into valid SequenceGroup[].
 *  Stray top-level items (e.g. a bare `else`) are absorbed into the current
 *  group; empty groups are dropped. This makes the tool tolerant of the common
 *  LLM mistake of emitting an `else` (or message) as a sibling of groups. */
export function coerceSequenceGroups(raw: unknown): SequenceGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: SequenceGroup[] = [];
  let current: SequenceGroup | null = null;
  for (const entry of raw) {
    const keyword = entry && typeof entry === "object" ? (entry as Record<string, unknown>).keyword : undefined;
    if (typeof keyword === "string" && GROUP_KEYWORDS.has(keyword)) {
      const g = entry as Record<string, unknown>;
      const items = Array.isArray(g.items)
        ? g.items.map(coerceGroupItem).filter((x): x is SequenceGroupItem => x != null)
        : [];
      current = { keyword: keyword as SequenceGroup["keyword"], label: g.label != null ? String(g.label) : undefined, items };
      out.push(current);
    } else {
      const item = coerceGroupItem(entry);
      if (item) {
        if (!current) {
          current = { keyword: "alt", items: [] };
          out.push(current);
        }
        current.items.push(item);
      }
    }
  }
  return out.filter((g) => g.items.length > 0);
}

// ---------------------------------------------------------------------------
// High-level render helpers: raw override wins, else build from structure
// ---------------------------------------------------------------------------

export interface RenderSequenceInput extends Omit<SequenceFromStepsInput, "groups"> {
  /** Raw Mermaid override; sanitized, not used verbatim. */
  sequence?: string;
  /** Loosely-shaped groups; coerced/repaired before building. */
  groups?: unknown;
}

export function renderSequence(input: RenderSequenceInput): string {
  if (input.sequence) return sanitizeMermaidSequence(input.sequence);
  const groups = coerceSequenceGroups(input.groups);
  try {
    return buildSequenceDiagram({
      participants: input.participants,
      steps: input.steps,
      notes: input.notes,
      groups,
    });
  } catch {
    // Ultimate safety net: never fail the render. Drop decorations, keep the
    // grounded steps so the window always opens with a valid diagram.
    return buildSequenceDiagram({ participants: input.participants, steps: input.steps });
  }
}

export interface RenderFlowchartInput {
  /** Raw Mermaid override; sanitized, not used verbatim. */
  flowchart?: string;
  direction?: FlowchartInput["direction"];
  nodes?: FlowchartNode[];
  edges?: FlowchartEdge[];
  subgraphs?: FlowchartSubgraph[];
}

export function renderFlowchart(input: RenderFlowchartInput): string | undefined {
  if (input.flowchart) return sanitizeMermaidFlowchart(input.flowchart);
  if (!input.nodes || input.nodes.length === 0) return undefined;
  try {
    return buildFlowchart({
      direction: input.direction,
      nodes: input.nodes,
      edges: input.edges ?? [],
      subgraphs: input.subgraphs,
    });
  } catch {
    return undefined;
  }
}
