// End-to-end MCP smoke test: spawn the built stdio server, list tools, call
// render_call_diagram (which opens the native window), then close.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["dist/mcp-server.mjs"] });
const client = new Client({ name: "callflow-smoke", version: "0.0.0" });

await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));
if (!tools.some((t) => t.name === "render_call_diagram")) {
  console.error("render_call_diagram not advertised");
  process.exit(1);
}

const res = await client.callTool({
  name: "render_call_diagram",
  arguments: {
    title: "MCP smoke — login flow",
    sequence: `sequenceDiagram
    participant C as Client
    participant A as AuthController
    C->>A: POST /auth/authorize (grant)
    A-->>C: SUCCESS`,
    flowchart: `flowchart TD
    A[authorize] --> B{mfa?} -->|yes| C[mfa] -->|no| D[SUCCESS]`,
    steps: [
      { from: "Client", to: "AuthController", call: "POST /auth/authorize", file: "server/AuthController.java", line: 88 },
    ],
    notes: "spawned via MCP stdio",
  },
});
const text = (res.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n");
console.log("callTool result:\n" + text);

await new Promise((r) => setTimeout(r, 1500));
await client.close();
console.log("mcp smoke ok");
process.exit(0);
