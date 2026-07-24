import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFlowchart,
  buildSequenceDiagram,
  coerceSequenceGroups,
  renderFlowchart,
  renderSequence,
  sanitizeMermaidSequence,
} from "../src/core/mermaid.ts";

test("sequence: quotes participant labels and escapes special chars", () => {
  const out = buildSequenceDiagram({
    participants: [{ id: "Bot", label: "grammY Bot<br/>(bot-core.ts)" }],
    steps: [{ from: "Bot", to: "Bot", call: "answerCallbackQuery (early, <15s)" }],
  });
  assert.match(out, /participant Bot as "grammY Bot<br\/>\(bot-core\.ts\)"/);
  assert.match(out, /Bot->>Bot: "answerCallbackQuery \(early, <15s\)"/);
});

test("sequence: escapes semicolons as #59; (even inside quotes)", () => {
  const out = buildSequenceDiagram({
    steps: [{ from: "A", to: "B", call: "dispatch turn; reply payloads" }],
  });
  assert.match(out, /A->>B: "dispatch turn#59; reply payloads"/);
  assert.doesNotMatch(out, /reply payloads";/); // no bare semicolon leaking as separator
});

test("sequence: does not double-escape existing #59; entity", () => {
  const out = buildSequenceDiagram({
    steps: [{ from: "A", to: "B", call: "already#59;escaped" }],
  });
  assert.match(out, /A->>B: "already#59;escaped"/);
  assert.doesNotMatch(out, /#59#59;/);
});

test("sequence: request vs response arrows", () => {
  const out = buildSequenceDiagram({
    steps: [
      { from: "A", to: "B", call: "call", kind: "request" },
      { from: "B", to: "A", call: "return", kind: "response" },
    ],
  });
  assert.match(out, /A->>B: "call"/);
  assert.match(out, /B-->>A: "return"/);
  assert.doesNotMatch(out, /--->>/); // no triple-dash bug
});

test("sequence: auto-derives participants from steps when not given", () => {
  const out = buildSequenceDiagram({
    steps: [{ from: "X", to: "Y", call: "go" }],
  });
  assert.match(out, /participant X as "X"/);
  assert.match(out, /participant Y as "Y"/);
});

test("sequence: renders per-step note over both participants", () => {
  const out = buildSequenceDiagram({
    steps: [{ from: "A", to: "B", call: "go", note: "branch here" }],
  });
  assert.match(out, /Note over A,B: "branch here"/);
});

test("sequence: renders alt group with else and nested items", () => {
  const out = buildSequenceDiagram({
    steps: [],
    groups: [
      {
        keyword: "alt",
        label: "polling",
        items: [
          { type: "message", from: "A", to: "B", text: "poll" },
          { type: "else", label: "webhook" },
          { type: "note", position: "over", participants: ["A", "B"], text: "set hook" },
        ],
      },
    ],
  });
  assert.match(out, /alt "polling"/);
  assert.match(out, /A->>B: "poll"/);
  assert.match(out, /else "webhook"/);
  assert.match(out, /Note over A,B: "set hook"/);
  assert.match(out, /\n {4}end$/);
});

test("flowchart: node shapes and quoted labels", () => {
  const out = buildFlowchart({
    direction: "TD",
    nodes: [
      { id: "G", label: "grant()", shape: "stadium" },
      { id: "D", label: "mfa_type?", shape: "diamond" },
      { id: "OK", label: "SUCCESS (tokens)" },
    ],
    edges: [
      { from: "G", to: "D" },
      { from: "D", to: "OK", label: "otp; verified" },
    ],
  });
  assert.match(out, /^flowchart TD/);
  assert.match(out, /G\(\["grant\(\)"\]\)/);
  assert.match(out, /D\{"mfa_type\?"\}/);
  assert.match(out, /OK\["SUCCESS \(tokens\)"\]/);
  assert.match(out, /G --> D/);
  assert.match(out, /D -->\|"otp#59; verified"\| OK/);
});

test("flowchart: subgraph with direction", () => {
  const out = buildFlowchart({
    nodes: [{ id: "A", label: "a" }],
    edges: [],
    subgraphs: [
      { label: "grp", direction: "LR", nodes: [{ id: "B", label: "b" }], edges: [{ from: "A", to: "B" }] },
    ],
  });
  assert.match(out, /subgraph "grp"/);
  assert.match(out, /direction LR/);
  assert.match(out, /end$/);
});

test("renderSequence: raw override is sanitized, not built", () => {
  const raw = "sequenceDiagram\n    A->>B: answerCallbackQuery (early, <15s)";
  const out = renderSequence({ sequence: raw, steps: [] });
  assert.match(out, /A->>B: "answerCallbackQuery \(early, <15s\)"/);
});

test("renderFlowchart: undefined when no nodes and no raw override", () => {
  assert.equal(renderFlowchart({ nodes: [], edges: [] }), undefined);
  assert.equal(renderFlowchart({}), undefined);
});

test("sanitizeMermaidSequence: leaves already-quoted labels alone", () => {
  const raw = 'sequenceDiagram\n    participant A as "Already Quoted"';
  const out = sanitizeMermaidSequence(raw);
  assert.match(out, /participant A as "Already Quoted"/);
  assert.doesNotMatch(out, /""/);
});

test("escape: newlines in labels/text become <br/>", () => {
  const seq = buildSequenceDiagram({
    participants: [{ id: "A", label: "Line1\nLine2" }],
    steps: [{ from: "A", to: "A", call: "do\nthing" }],
  });
  assert.match(seq, /participant A as "Line1<br\/>Line2"/);
  assert.match(seq, /A->>A: "do<br\/>thing"/);
  const fc = buildFlowchart({ nodes: [{ id: "N", label: "Long polling\ngetUpdates" }], edges: [] });
  assert.match(fc, /N\["Long polling<br\/>getUpdates"\]/);
});

test("coerceSequenceGroups: absorbs a stray top-level else into previous group", () => {
  const groups = coerceSequenceGroups([
    { keyword: "alt", label: "polling", items: [{ type: "message", from: "A", to: "B", text: "poll" }] },
    { type: "else", label: "webhook" },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].items.length, 2);
  assert.deepEqual(groups[0].items[1], { type: "else", label: "webhook" });
});

test("coerceSequenceGroups: drops empty groups and unknown items", () => {
  const groups = coerceSequenceGroups([
    { keyword: "alt", label: "empty", items: [] },
    { keyword: "opt", label: "ok", items: [{ type: "message", from: "A", to: "B", text: "x" }, { type: "bogus" }] },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].keyword, "opt");
  assert.equal(groups[0].items.length, 1);
});

test("renderSequence: tolerates loose groups with a top-level else (no throw)", () => {
  const out = renderSequence({
    participants: [{ id: "A", label: "A" }, { id: "B", label: "B" }],
    steps: [{ from: "A", to: "B", call: "go" }],
    groups: [
      { keyword: "alt", label: "p", items: [{ type: "message", from: "A", to: "B", text: "poll" }] },
      { type: "else", label: "shared" },
    ],
  });
  assert.match(out, /alt "p"/);
  assert.match(out, /else "shared"/);
  assert.match(out, /\n {4}end/);
});
