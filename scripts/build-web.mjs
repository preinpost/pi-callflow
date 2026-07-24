import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

const outdir = new URL("../web/dist/", import.meta.url);
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// Bundle mermaid + app into a single IIFE (no CDN, works offline / on closed networks).
await build({
  entryPoints: ["web/src/app.ts"],
  bundle: true,
  format: "iife",
  target: "es2022",
  outfile: "web/dist/app.js",
  sourcemap: false,
  minify: true,
});

const [template, appStyles, appSource] = await Promise.all([
  readFile(new URL("../web/src/index.html", import.meta.url), "utf8"),
  readFile(new URL("../web/src/styles.css", import.meta.url), "utf8"),
  readFile(new URL("app.js", outdir), "utf8"),
]);

// Inline everything so the viewer HTML is fully self-contained.
// Guard against literal closing tags inside minified content breaking the HTML.
const safeStyles = appStyles.replace(/<\/style/gi, "<\\/style");
const safeSource = appSource.replace(/<\/script/gi, "<\\/script");
const html = template
  .replace("__APP_STYLES_BASE64__", () => safeStyles)
  .replace("__APP_SOURCE_BASE64__", () => safeSource);

await writeFile(new URL("index.html", outdir), html, "utf8");
console.log("Built web/dist/index.html (self-contained, mermaid inlined).");
