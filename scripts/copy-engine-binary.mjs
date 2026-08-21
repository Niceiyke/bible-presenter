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
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync } from "node:fs";
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

// The ffmpeg shared-library DLLs that tauri.conf.json bundles
// (`binaries/<name>.dll` -> `bin/<name>.dll`). Parsed from the config instead
// of hardcoded here so the list can never drift from what tauri-build's
// existence check requires at cargo-build time.
function requiredFfmpegDlls() {
  const conf = JSON.parse(
    readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")
  );
  const resources = conf.bundle?.resources ?? {};
  return Object.keys(resources)
    .filter((key) => /^binaries\/[^/]+\.dll$/i.test(key))
    .map((key) => key.slice("binaries/".length))
    .sort();
}

const dlls = requiredFfmpegDlls();

function vcpkgBinDir() {
  const vcpkgRoot = process.env.VCPKG_ROOT || "C:\\vcpkg";
  return join(vcpkgRoot, "installed", "x64-windows", "bin");
}

function dllIsStaged(name) {
  const dest = join(binDir, name);
  return existsSync(dest) && statSync(dest).size > 0;
}

// Stage the runtime DLLs the dynamically linked engine needs (ffmpeg-sys-next
// with VCPKGRS_DYNAMIC=1; vcpkg installs them to
// {VCPKG_ROOT}/installed/x64-windows/bin/av*.dll + sw*.dll), then VERIFY every
// DLL tauri.conf.json bundles is present and real. A leftover 0-byte bootstrap
// placeholder or a vcpkg port bump that renames libraries (e.g.
// avcodec-63.dll -> avcodec-64.dll) must fail the bundle loudly here — an
// installer whose engine cannot load libav would otherwise fail only at the
// customer's first launch.
function stageFfmpegDlls() {
  const vcpkgBin = vcpkgBinDir();
  let missing;
  if (existsSync(vcpkgBin)) {
    for (const f of readdirSync(vcpkgBin)) {
      if (/^(av|sw).+\.dll$/i.test(f)) {
        try {
          copyFileSync(join(vcpkgBin, f), join(binDir, f));
          console.log(`[copy-engine-binary] staged ${f}`);
        } catch (e) {
          console.warn(`[copy-engine-binary] failed to stage ${f}: ${e.message}`);
        }
      }
    }
    // A reachable vcpkg is authoritative: every configured DLL must be
    // provided by THIS install AND land in binaries/, so neither a version
    // bump nor a failed copy can be masked by a stale file left over from an
    // earlier build.
    missing = dlls.filter(
      (name) => !existsSync(join(vcpkgBin, name)) || !dllIsStaged(name)
    );
  } else {
    missing = dlls.filter((name) => !dllIsStaged(name));
    if (missing.length === 0) {
      console.warn(
        `[copy-engine-binary] ${vcpkgBin} not found; using already-staged DLLs`
      );
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `[copy-engine-binary] ffmpeg DLLs required by tauri.conf.json are missing, ` +
        `stale, or still placeholders: ${missing.join(", ")}. Install ` +
        `ffmpeg:x64-windows into vcpkg and update the resources map to match ` +
        `(${vcpkgBin}).`
    );
  }
}

if (existsSync(src)) {
  // Real binary available (normal case at beforeBundleCommand time).
  for (const name of targets) {
    copyFileSync(src, join(binDir, name));
    console.log(`[copy-engine-binary] staged ${name}`);
  }
  // Bundle the ffmpeg runtime DLLs beside the sidecar so tauri.conf.json can
  // ship them at bin/ (see stageFfmpegDlls for the verification contract).
  stageFfmpegDlls();
} else if (bootstrap) {
  // Pre-build bootstrap: satisfy tauri-build's layout validation only.
  for (const name of targets) {
    const dest = join(binDir, name);
    if (!existsSync(dest)) {
      writeFileSync(dest, "");
      console.log(`[copy-engine-binary] wrote placeholder ${name}`);
    }
  }
  // Same for the bundled ffmpeg DLLs: tauri-build validates their paths during
  // cargo build, before beforeBundleCommand stages the real files from vcpkg.
  for (const name of dlls) {
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
