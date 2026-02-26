# Auto-Updater Setup

The app uses `tauri-plugin-updater` to check for updates on startup and install them in-place.

---

## How it works

1. On launch, the main window silently calls `check()` against the GitHub Releases endpoint.
2. If a newer version exists, a blue banner appears at the top of the operator window.
3. Clicking **Install & Restart** downloads and installs the update, then relaunches the app.
4. The banner can be dismissed per-session.

---

## Releasing an update

1. Bump `version` in `src-tauri/tauri.conf.json`:
   ```json
   "version": "0.2.0"
   ```
2. Commit and push to `main`.
3. CI (`tauri-apps/tauri-action@v0`) builds, signs, and publishes a GitHub Release tagged `v0.2.0` with:
   - `Bible-Presenter-RS_0.2.0_x64-setup.exe` — NSIS installer
   - `latest.json` — update manifest consumed by running apps

Running instances will show the update banner on their next launch.

### What happens if you push without bumping the version?

The CI workflow has two jobs:

- **`check-version`** — runs on Ubuntu in ~5 seconds, reads the version from `tauri.conf.json` and checks if the tag already exists on GitHub.
- **`build`** — only runs if the tag is new. If the tag already exists, this job is **skipped entirely** — no Windows runner, no model downloads, no Rust compile.

So routine pushes that don't bump the version cost virtually nothing in CI time, and users see no update banner.

---

## Signing keypair

| Item | Location |
|---|---|
| Private key | `~/.tauri/bible-presenter.key` on the VPS (never committed) |
| Public key | `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` (committed) |

### GitHub Secrets required

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `~/.tauri/bible-presenter.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password chosen during keygen (blank if none) |
| `GITHUB_TOKEN` | Provided automatically by GitHub Actions |

### Regenerating the keypair (if needed)

```bash
cd /home/niceiyke/project/bible-presenter/desktop-rs
npm run tauri signer generate -- -w ~/.tauri/bible-presenter.key
```

Paste the new public key into `src-tauri/tauri.conf.json` and update the GitHub Secret.

---

## Files changed

| File | What was added |
|---|---|
| `src-tauri/Cargo.toml` | `tauri-plugin-updater = "2"`, `tauri-plugin-process = "2"` |
| `src-tauri/src/main.rs` | `.plugin(tauri_plugin_updater::Builder::new().build())`, `.plugin(tauri_plugin_process::init())` |
| `src-tauri/capabilities/default.json` | `"updater:default"`, `"process:allow-relaunch"` |
| `src-tauri/tauri.conf.json` | `plugins.updater` block with pubkey + endpoint |
| `package.json` | `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process` |
| `src/App.tsx` | Update check on init + dismissible banner UI |
| `.github/workflows/build-windows.yml` | Split into `check-version` + `build` jobs; `build` skipped when tag exists; uses `tauri-apps/tauri-action@v0` |
