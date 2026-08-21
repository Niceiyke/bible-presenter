// Stages the freshly built `wordlyte-engine` sidecar into src-tauri/binaries/
// so the bundler ships it inside the resource dir (`binaries/wordlyte-engine.exe`
// -> `wordlyte-engine.exe`, resolved by main.rs via the resource dir).
//
// tauri-build's build script validates the bundle layout at cargo-build time,
// but the engine binary is a `[[bin]]` of this same crate — it only exists
// AFTER that cargo build finishes. Two invocation modes break the loop:
//
// - `--bootstrap` (wired into beforeBuildCommand/beforeDevCommand): runs
//   BEFORE cargo build. Writes a 0-byte placeholder when no binary has been
//   staged yet, so tauri-build's existence check passes on a fresh checkout.
//   The upcoming cargo build then compiles the real engine over the copied
//   placeholder in the target dir (build scripts run before targets compile).
// - no args (beforeBundleCommand): runs AFTER cargo build produced
//   `target/release/wordlyte-engine.exe` and BEFORE the bundler reads the
//   config. Stages the real binary, replacing any placeholder, so the
//   installer always ships what this build produced. Fails loudly when the
//   binary is missing so a broken build can never ship a placeholder.
//
// The script must NOT build the engine itself (any `cargo build` on this
// package hits the same validation). It resolves paths from its own location,
// so it works regardless of the hook's working directory.
import { copyFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const bootstrap = process.argv.includes("--bootstrap");
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

const binDir = join(root, "src-tauri", "binaries");
mkdirSync(binDir, { recursive: true });

const triple = hostTriple();
const targets = [
  base + ext,                // what main.rs resolves in the resource dir
  `${base}-${triple}${ext}`, // triple-suffixed fallback
];

if (existsSync(src)) {
  // Real binary available (normal case at beforeBundleCommand time).
  for (const name of targets) {
    copyFileSync(src, join(binDir, name));
    console.log(`[copy-engine-binary] staged ${name}`);
  }
  // Bundle ffmpeg DLLs for in-process backend (dynamic VCPKGRS_DYNAMIC=1).
  // vcpkg installs them to C:\vcpkg\installed\x64-windows\bin\av*.dll / sw*.dll
  // Copy them to binDir so tauri.conf.json resources can ship them at bin/.
  try {
    const vcpkgBin = "C:\\vcpkg\\installed\\x64-windows\\bin";
    if (existsSync(vcpkgBin)) {
      for (const f of readdirSync(vcpkgBin)) {
        if (/^(av|sw).+\.dll$/i.test(f)) {
          const srcDll = join(vcpkgBin, f);
          const destDll = join(binDir, f);
          try {
            copyFileSync(srcDll, destDll);
            console.log(`[copy-engine-binary] staged ${f}`);
          } catch (e) {
            console.warn(`[copy-engine-binary] failed to stage ${f}: ${e.message}`);
          }
        }
      }
    }
  } catch (e) {
    console.warn(`[copy-engine-binary] ffmpeg DLL staging skipped: ${e.message}`);
  }
} else if (bootstrap) {
  // Pre-build bootstrap: satisfy tauri-build's layout validation only.
  for (const name of targets) {
    const dest = join(binDir, name);
    if (!existsSync(dest)) {
      writeFileSync(dest, "");
      console.log(`[copy-engine-binary] wrote placeholder ${name}`);
    }
  }
} else {
  throw new Error(
    `Sidecar binary not found at ${src}; run \`cargo build --release\` first`
  );
}
