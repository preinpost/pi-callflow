import { build } from "esbuild";
import { chmod, readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));

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
  define: {
    __PKG_NAME__: JSON.stringify(pkg.name),
    __PKG_VERSION__: JSON.stringify(pkg.version),
  },
  minify: false,
});

await chmod("dist/mcp-server.mjs", 0o755);
console.log("Built dist/mcp-server.mjs (stdio MCP server).");
