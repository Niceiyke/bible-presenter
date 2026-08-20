// Stages the freshly built `wordlyte-engine` sidecar into src-tauri/binaries/
// so the bundler ships it inside the resource dir (`binaries/wordlyte-engine.exe`
// -> `wordlyte-engine.exe`, resolved by main.rs via the resource dir).
//
// Runs via `build.beforeBundleCommand` (after `cargo build` compiled both the
// console and the engine binary, before bundling). It must NOT build the engine
// itself: tauri-build's build script validates the bundle layout at cargo-build
// time, so any `cargo build` on this package has the same chicken-and-egg
// problem. The script resolves paths from its own location, so it works
// regardless of the hook's working directory.
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
  base + ext,                // what main.rs resolves in the resource dir
  `${base}-${triple}${ext}`, // triple-suffixed fallback
];
for (const name of targets) {
  copyFileSync(src, join(binDir, name));
  console.log(`[copy-engine-binary] staged ${name}`);
}