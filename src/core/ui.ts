import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolve the self-contained viewer HTML across run modes:
//  - src/core/ui.ts run directly (pi / tsx):        ../../web/dist/index.html
//  - bundled to <root>/dist/mcp-server.mjs (MCP):   ../web/dist/index.html
const CANDIDATES = ["../../web/dist/index.html", "../web/dist/index.html"];

/** Reads the self-contained, network-free viewer HTML (mermaid bundled inline). */
export function loadCallflowHtml(): string {
  for (const rel of CANDIDATES) {
    const path = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  throw new Error(
    "callflow viewer HTML not found (web/dist/index.html). Run `npm run build:web` first.",
  );
}
