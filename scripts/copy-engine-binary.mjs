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

// Runtime shared-library locations declared as bundle resources in
// tauri.conf.json (`binaries/dll/*.dll` -> `.`). The ffmpeg DLL names embed
// the library major version (avcodec-63.dll, swresample-7.dll, ...) and vcpkg
// bumps them whenever its ffmpeg port updates, so the config maps a GLOB
// instead of listing files: whatever this build's vcpkg provides is exactly
// what ships. The `.` target flattens every match into the bundle ROOT,
// beside wordlyte.exe / wordlyte-engine.exe — the DLLs are load-time imports,
// and the Windows loader searches only the exe's own folder (+ system dirs /
// PATH) before any app code runs, so a `bin/` subfolder can never satisfy
// them (SetDllDirectoryW runs far too late). tauri-build validates resource
// patterns at cargo-build time and an UNMATCHED glob is an error
// (GlobPathNotFound), so --bootstrap must leave at least one 0-byte *.dll
// placeholder in place for a fresh checkout.
function runtimeLibDirs() {
  const conf = JSON.parse(
    readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")
  );
  const resources = conf.bundle?.resources ?? {};
  const dirs = [];
  for (const key of Object.keys(resources)) {
    if (!/^binaries\//i.test(key)) continue;
    if (key.includes("*")) {
      // Glob key (`binaries/dll/*.dll`): stage under the literal prefix
      // relative to binaries/ (the leading segment is binDir itself).
      const segs = key.split("/").filter((seg) => !seg.includes("*"));
      if (segs.length && /^binaries$/i.test(segs[0])) segs.shift();
      dirs.push(join(binDir, ...segs));
      continue;
    }
    const base = key.slice("binaries/".length);
    if (base.length > 0 && !base.includes(".")) {
      dirs.push(join(binDir, base)); // legacy plain-directory key
    }
  }
  return [...new Set(dirs)];
}

const libDirs = runtimeLibDirs();

// Where this build's runtime DLLs live: a vcpkg x64-windows install is
// authoritative when present; otherwise $FFMPEG_DIR/bin (a shared ffmpeg
// build, what ffmpeg-sys-next links against); null when neither exists.
function libSourceDir() {
  const candidates = [];
  if (process.env.VCPKG_ROOT) {
    candidates.push(join(process.env.VCPKG_ROOT, "installed", "x64-windows", "bin"));
  }
  candidates.push("C:\\vcpkg\\installed\\x64-windows\\bin");
  if (process.env.FFMPEG_DIR) {
    candidates.push(join(process.env.FFMPEG_DIR, "bin"));
  }
  return candidates.find((dir) => existsSync(dir)) ?? null;
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
// linking libav; vcpkg installs av*.dll + sw*.dll to
// {VCPKG_ROOT}/installed/x64-windows/bin, shared FFMPEG_DIR builds keep them
// in {FFMPEG_DIR}/bin). A resolved source dir is authoritative: staged DLLs
// that THIS source does not provide are swept first, so the shipped set always
// matches exactly what compiled and linked this build and a leftover from an
// earlier build can never ride along. Fails loudly when nothing usable was
// staged - an installer whose engine cannot load libav would otherwise fail
// only at the customer's first launch.
function stageFfmpegDlls() {
  for (const dir of libDirs) {
    mkdirSync(dir, { recursive: true });
  }
  const libSource = libSourceDir();
  if (libSource) {
    for (const f of readdirSync(libSource)) {
      if (!isRuntimeDll(f)) continue;
      for (const dir of libDirs) {
        try {
          copyFileSync(join(libSource, f), join(dir, f));
        } catch (e) {
          console.warn(`[copy-engine-binary] failed to stage ${f}: ${e.message}`);
        }
      }
      console.log(`[copy-engine-binary] staged ${f}`);
    }
    for (const dir of libDirs) {
      for (const f of readdirSync(dir)) {
        // Sweep ANY staged .dll this source does not provide — including the
        // --bootstrap placeholder — so only the linked set ships.
        if (!/\.dll$/i.test(f)) continue;
        if (!existsSync(join(libSource, f))) {
          rmSync(join(dir, f));
          console.warn(`[copy-engine-binary] removed stale ${f}`);
        }
      }
    }
  } else {
    console.warn(
      "[copy-engine-binary] no vcpkg x64-windows install or $FFMPEG_DIR/bin found; keeping already-staged DLLs"
    );
  }
  const total = libDirs.reduce((n, dir) => n + stagedDllCount(dir), 0);
  if (total === 0) {
    throw new Error(
      `[copy-engine-binary] no ffmpeg runtime DLLs were staged into ` +
        `${libDirs.join(", ")}. Provide them via vcpkg (ffmpeg:x64-windows, ` +
        `set VCPKG_ROOT), a shared FFMPEG_DIR build (bin/*.dll), or pre-stage ` +
        `av*/sw*.dll files matching the libav version this build linked against.`
    );
  }
}

if (existsSync(src)) {
  // Real binary available (normal case at beforeBundleCommand time).
  for (const name of targets) {
    copyFileSync(src, join(binDir, name));
    console.log(`[copy-engine-binary] staged ${name}`);
  }
  // Bundle the ffmpeg runtime DLLs at the bundle ROOT beside both exes so
  // tauri.conf.json can ship them via `binaries/dll/*.dll` -> `.` (see
  // runtimeLibDirs for the verification contract).
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
  // Runtime lib dirs (`binaries/dll/*.dll` -> `.`): tauri-build errors on an
  // unmatched resource glob during its cargo-build-time validation, so each
  // staged dir needs at least one *.dll placeholder on a fresh checkout;
  // beforeBundleCommand replaces it with the real vcpkg DLLs (and sweeps it).
  for (const dir of libDirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      console.log(`[copy-engine-binary] created ${dir}/`);
    }
    const hasDll = readdirSync(dir).some((f) => /\.dll$/i.test(f));
    if (!hasDll) {
      writeFileSync(join(dir, "placeholder.dll"), "");
      console.log(`[copy-engine-binary] wrote placeholder ${dir}/placeholder.dll`);
    }
  }
} else {
  throw new Error(
    `Sidecar binary not found at ${src}; run \`cargo build --release\` first`
  );
}
