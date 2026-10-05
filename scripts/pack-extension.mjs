// Zips extension/ into web/downloads/reclaim-extension.zip so the web app's Privacy tab can offer
// it as a download (the web app is static -- no server -- so the zip is committed and deployed
// with web/). Re-run this whenever anything under extension/ changes: node scripts/pack-extension.mjs
// Tests are left out; the zip's root is the extension itself, so "Load unpacked" works on the
// unzipped folder directly. Uses the system tar (bsdtar on Windows 10+/macOS; -a picks zip from
// the .zip name) so no new npm dependency is needed.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Windows: use the built-in bsdtar explicitly -- Git Bash puts GNU tar first on PATH, which can't write zips.
const TAR = process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "extension");
const out = join(root, "web", "downloads", "reclaim-extension.zip");

mkdirSync(dirname(out), { recursive: true });
rmSync(out, { force: true });
const entries = readdirSync(src).filter((name) => name !== "tests");
execFileSync(TAR, ["-a", "-c", "-f", out, "-C", src, ...entries], { stdio: "inherit" });
console.log(`Wrote ${out}`);
