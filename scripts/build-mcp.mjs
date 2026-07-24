import { build } from "esbuild";
import { chmod } from "node:fs/promises";

// Bundle the stdio MCP server into a single runnable file at <root>/dist/mcp-server.mjs.
// glimpseui is kept external (native binary resolved from node_modules at runtime).
await build({
  entryPoints: ["src/mcp/server.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: "dist/mcp-server.mjs",
  external: ["glimpseui"],
  banner: { js: "#!/usr/bin/env node" },
  minify: false,
});

await chmod("dist/mcp-server.mjs", 0o755);
console.log("Built dist/mcp-server.mjs (stdio MCP server).");
