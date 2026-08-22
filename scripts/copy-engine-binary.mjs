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
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
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

// Runtime shared-library directories declared as bundle resources in
// tauri.conf.json (`binaries/dll` -> `bin/`). The ffmpeg DLL names embed the
// library major version (avcodec-63.dll, swresample-7.dll, ...) and vcpkg
// bumps them whenever its ffmpeg port updates, so the config maps a DIRECTORY
// instead of listing files: whatever this build's vcpkg provides is exactly
// what ships. tauri-build validates resource paths at cargo-build time; an
// empty directory passes that check (tauri-utils skips empty walks), so
// --bootstrap only has to create it.
function runtimeLibDirs() {
  const conf = JSON.parse(
    readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")
  );
  const resources = conf.bundle?.resources ?? {};
  return Object.keys(resources)
    .filter((key) => {
      if (!/^binaries\//i.test(key) || key.includes("*")) return false;
      const base = key.slice("binaries/".length);
      return base.length > 0 && !base.includes("."); // directory, not a file
    })
    .map((key) => join(binDir, key.slice("binaries/".length)));
}

const libDirs = runtimeLibDirs();

function vcpkgBinDir() {
  const vcpkgRoot = process.env.VCPKG_ROOT || "C:\\vcpkg";
  return join(vcpkgRoot, "installed", "x64-windows", "bin");
}

function isRuntimeDll(name) {
  return /^(av|sw).+\.dll$/i.test(name);
}

function stagedDllCount(dir) {
  try {
    return readdirSync(dir).filter((f) => {
      if (!isRuntimeDll(f)) return false;
      const st = statSync(join(dir, f));
      return st.isFile() && st.size > 0;
    }).length;
  } catch {
    return 0;
  }
}

// Stage the runtime DLLs the dynamically linked engine needs (ffmpeg-sys-next
// with VCPKGRS_DYNAMIC=1; vcpkg installs av*.dll + sw*.dll to
// {VCPKG_ROOT}/installed/x64-windows/bin). A reachable vcpkg is authoritative:
// staged DLLs that THIS install does not provide are swept first, so the
// shipped set always matches exactly what compiled and linked this build and
// a leftover from an earlier build can never ride along. Fails loudly when
// nothing usable was staged - an installer whose engine cannot load libav
// would otherwise fail only at the customer's first launch.
function stageFfmpegDlls() {
  for (const dir of libDirs) {
    mkdirSync(dir, { recursive: true });
  }
  const vcpkgBin = vcpkgBinDir();
  if (existsSync(vcpkgBin)) {
    for (const f of readdirSync(vcpkgBin)) {
      if (!isRuntimeDll(f)) continue;
      for (const dir of libDirs) {
        try {
          copyFileSync(join(vcpkgBin, f), join(dir, f));
        } catch (e) {
          console.warn(`[copy-engine-binary] failed to stage ${f}: ${e.message}`);
        }
      }
      console.log(`[copy-engine-binary] staged ${f}`);
    }
    for (const dir of libDirs) {
      for (const f of readdirSync(dir)) {
        if (!isRuntimeDll(f)) continue;
        if (!existsSync(join(vcpkgBin, f))) {
          rmSync(join(dir, f));
          console.warn(`[copy-engine-binary] removed stale ${f}`);
        }
      }
    }
  } else {
    console.warn(
      `[copy-engine-binary] ${vcpkgBin} not found; keeping already-staged DLLs`
    );
  }
  const total = libDirs.reduce((n, dir) => n + stagedDllCount(dir), 0);
  if (total === 0) {
    throw new Error(
      `[copy-engine-binary] no ffmpeg runtime DLLs were staged into ` +
        `${libDirs.join(", ")}. Install ffmpeg:x64-windows into vcpkg ` +
        `(set VCPKG_ROOT if it lives elsewhere) or pre-stage av*/sw*.dll ` +
        `files matching the libav version this build linked against.`
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
  // Runtime lib dirs (binaries/dll -> bin/): tauri-build skips empty
  // directory walks during its cargo-build-time validation, so creating them
  // is enough on a fresh checkout; beforeBundleCommand stages the real DLLs
  // before the bundler reads them.
  for (const dir of libDirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      console.log(`[copy-engine-binary] created ${dir}/`);
    }
  }
} else {
  throw new Error(
    `Sidecar binary not found at ${src}; run \`cargo build --release\` first`
  );
}
