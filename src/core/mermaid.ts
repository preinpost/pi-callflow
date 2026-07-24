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

/** Characters that break Mermaid parsing, even inside quoted text. */
function escapeMermaidText(value: string): string {
  return value
    .replace(/"/g, "#quot;")
    .replace(/(?<!&#?\d+);/g, "#59;");
}

function mermaidQuoted(value: string): string {
  return `"${escapeMermaidText(value)}"`;
}

// ---------------------------------------------------------------------------
// Sequence diagram builder
// ---------------------------------------------------------------------------

function arrowFor(kind: "request" | "response" | undefined): string {
  return kind === "response" ? "-->>" : ">>";
}

function renderMessageLine(
  from: string,
  to: string,
  text: string,
  kind?: "request" | "response",
  indent = "    ",
): string {
  return `${indent}${from}-${arrowFor(kind)}${to}: ${mermaidQuoted(text)}`;
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
