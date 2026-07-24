/** A single call step in a flow. `file`/`line` are the grounding contract. */
export interface CallStep {
  index: number;
  from: string;
  to: string;
  call: string;
  file: string;
  line: number;
  note?: string;
}

export interface Diagram {
  title: string;
  /** Mermaid 'sequenceDiagram' source (primary, always shown). */
  sequence: string;
  /** Optional Mermaid 'flowchart' source (secondary, shown in a collapsible section). */
  flowchart?: string;
  steps: CallStep[];
  notes?: string;
  generatedAt: number;
}

export interface EditorOption {
  id: string;
  label: string;
}

/** host -> webview. index/total describe the position in the history stack. */
export type HostMessage =
  | { type: "diagram"; diagram: Diagram; index: number; total: number }
  | { type: "empty" }
  | { type: "editors"; list: EditorOption[]; selected: string | null; locked: boolean };

/** webview -> host */
export type WindowMessage =
  | { type: "ready" }
  | { type: "open-file"; file: string; line: number }
  | { type: "navigate"; direction: "prev" | "next" }
  | { type: "set-editor"; id: string }
  | { type: "close" };
