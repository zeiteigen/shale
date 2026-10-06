import { join } from "node:path";
const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "browser-content.ts")],
  target: "browser",
  format: "iife",
  minify: true,
});
if (!result.success) throw new Error(result.logs.join("\n"));
const content =
  "// Generated from browser-content.ts and lib/web-extraction.ts.\n" +
  (await result.outputs[0]!.text()) +
  "\nglobalThis.__shaleExtract();\n";
const path = join(import.meta.dir, "browser-chrome-extension/content.js");
if (process.argv.includes("--check")) {
  if ((await Bun.file(path).text()) !== content)
    throw new Error("Chrome content bundle is stale");
} else await Bun.write(path, content);
