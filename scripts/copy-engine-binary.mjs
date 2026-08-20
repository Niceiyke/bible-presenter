// Stages the freshly built `wordlyte-engine` sidecar into src-tauri/binaries/
// so Tauri's externalBin bundling ships it next to the main executable.
//
// Runs via `build.beforeBundleCommand` (after `cargo build`, before bundling).
// The script resolves paths from its own location, so it works regardless of
// the hook's working directory.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function hostTriple() {
  const out = execSync("rustc -vV", { encoding: "utf8" });
  const m = out.match(/^host:\s*(\S+)/m);
  if (!m) {
    throw new Error("Could not determine host target triple from rustc -vV");
  }
  return m[1];
}

const ext = process.platform === "win32" ? ".exe" : "";
const base = "wordlyte-engine";
const src = join(root, "src-tauri", "target", "release", base + ext);
if (!existsSync(src)) {
  throw new Error(
    `Sidecar binary not found at ${src}; run \`cargo build --release\` first`
  );
}

const binDir = join(root, "src-tauri", "binaries");
mkdirSync(binDir, { recursive: true });

const triple = hostTriple();
const targets = [
  `${base}-${triple}${ext}`, // what tauri's externalBin looks up
  base + ext,                // plain name fallback
];
for (const name of targets) {
  copyFileSync(src, join(binDir, name));
  console.log(`[copy-engine-binary] staged ${name}`);
}