// Rewrites WebLLM's single-file ES module as a classic script exposing window.webllm, since web/ loads plain <script> files (Electron opens it from file://).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const version = JSON.parse(readFileSync("package.json", "utf8")).dependencies["@mlc-ai/web-llm"];
const dir = mkdtempSync(join(tmpdir(), "webllm-"));
try {
  const tgz = execFileSync("npm", ["pack", `@mlc-ai/web-llm@${version}`, "--silent"], { cwd: dir }).toString().trim().split("\n").pop();
  execFileSync("tar", ["-xzf", tgz], { cwd: dir });
  const src = readFileSync(join(dir, "package/lib/index.js"), "utf8").replace(/\/\/# sourceMappingURL=.*$/m, "");

  if ((src.match(/^export /gm) || []).length !== 1 || /^import /m.test(src)) {
    throw new Error("expected a self-contained module with exactly one export statement; the conversion needs revisiting");
  }
  const exportRe = /^export \{([\s\S]*?)\};?/m;
  const names = src
    .match(exportRe)[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [local, exported = local] = s.split(/\s+as\s+/);
      return `${JSON.stringify(exported)}: ${local}`;
    });

  const out =
    `// @mlc-ai/web-llm ${version}, converted by scripts/vendor-webllm.mjs. Do not edit; re-run \`npm run vendor:webllm\`.\n` +
    `(function () {\n"use strict";\n${src.replace(exportRe, "")}\nwindow.webllm = { ${names.join(", ")} };\n})();\n`;
  writeFileSync("web/js/vendor/web-llm.js", out);
  console.log(`web/js/vendor/web-llm.js <- @mlc-ai/web-llm ${version} (${names.length} exports, ${(out.length / 1048576).toFixed(1)} MB)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
