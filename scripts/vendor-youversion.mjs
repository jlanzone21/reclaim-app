// Bundles @youversion/platform-core (plus its one dependency, zod) into a classic script exposing
// window.YouVersionPlatform = { ApiClient, BibleClient }, since web/ loads plain <script> files
// (Electron opens it from file://, Capacitor from its WebView) with no bundler of its own.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ESBUILD_VERSION = "0.25.10";
const version = JSON.parse(readFileSync("package.json", "utf8")).dependencies["@youversion/platform-core"];
const dir = mkdtempSync(join(tmpdir(), "youversion-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
try {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "yv-vendor", private: true }));
  execFileSync(npm, ["install", "--silent", "--no-audit", "--no-fund", `@youversion/platform-core@${version}`, `esbuild@${ESBUILD_VERSION}`], { cwd: dir, shell: process.platform === "win32" });
  writeFileSync(join(dir, "entry.js"), 'export { ApiClient, BibleClient } from "@youversion/platform-core";\n');
  execFileSync(
    npx,
    ["esbuild", "entry.js", "--bundle", "--minify", "--format=iife", "--global-name=YouVersionPlatform", "--platform=browser", "--target=es2020", "--legal-comments=none", "--outfile=out.js"],
    { cwd: dir, shell: process.platform === "win32" }
  );
  const out =
    `// @youversion/platform-core ${version}, bundled by scripts/vendor-youversion.mjs. Do not edit; re-run \`npm run vendor:youversion\`.\n` +
    `// Apache-2.0, https://github.com/youversion/platform-sdk-react\n` +
    readFileSync(join(dir, "out.js"), "utf8");
  writeFileSync("web/js/vendor/youversion-platform.js", out);
  console.log(`web/js/vendor/youversion-platform.js <- @youversion/platform-core ${version} (${(out.length / 1024).toFixed(1)} KB)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
