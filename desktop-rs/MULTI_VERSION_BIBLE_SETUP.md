# Multi-Version Bible Setup Guide

This guide walks you through setting up the multi-version Bible database and embeddings
for Bible Presenter RS. You only need to do this once.

## What Was Changed

| File | Change |
|---|---|
| `src-tauri/src/store/mod.rs` | Rewrote BibleStore for multi-version support |
| `src-tauri/src/main.rs` | Added `get_bible_versions`, `set_bible_version` commands; all Bible commands now accept `version` |
| `src-tauri/tauri.conf.json` | Updated bundled resources to new filenames |
| `src/App.tsx` | Version pill selector UI; all invoke calls pass `version` |
| `.github/workflows/build-windows.yml` | Downloads `super_bible.db` + `all_versions_embeddings.npy` at build time |
| `scripts/generate_embeddings.py` | CPU script (slow, use Colab instead) |
| `scripts/generate_embeddings_colab.ipynb` | **Recommended**: GPU notebook for Colab |

## Required Files

These files are NOT in the repo and must be generated/downloaded:

```
src-tauri/bible_data/
  super_bible.db                 # ~59 MB  — downloaded by CI from alshival/super_bible
  all_versions_embeddings.npy    # ~287 MB — generated via Colab, uploaded to GitHub Release
  verse_index.json               # ~3 MB   — generated via Colab, committed to repo
src-tauri/models/
  whisper-base.bin               # ~148 MB — downloaded by CI from HuggingFace
  all-minilm-l6-v2.onnx         # ~90 MB  — downloaded by CI from HuggingFace
  tokenizer.json                 # already committed
```

---

## Step 1 — Generate Embeddings (Google Colab)

This is a one-time step. It embeds all verses for 6 Bible versions (KJV, AMP, NIV, ESV, NKJV, NASB).

1. Go to [colab.research.google.com](https://colab.research.google.com)
2. **File → Upload notebook** → select `scripts/generate_embeddings_colab.ipynb`
3. **Runtime → Change runtime type → T4 GPU → Save**
4. **Runtime → Run all**

The notebook will:
- Download `super_bible.db` directly from GitHub (~59 MB)
- Generate embeddings for all 6 versions (~5–10 minutes on GPU)
- Auto-download two files to your computer:
  - `all_versions_embeddings.npy` (~287 MB)
  - `verse_index.json` (~3 MB)

---

## Step 2 — Commit `verse_index.json`

The `verse_index.json` is small enough to commit directly:

```bash
# Copy the downloaded file into the project
cp ~/Downloads/verse_index.json desktop-rs/src-tauri/bible_data/verse_index.json

git add desktop-rs/src-tauri/bible_data/verse_index.json
git commit -m "feat: add verse_index.json for multi-version stacked embeddings"
git push
```

---

## Step 3 — Create GitHub Release `v1.0-models`

The `all_versions_embeddings.npy` file (~287 MB) is too large for a regular commit.
Upload it as a GitHub Release asset:

1. Go to your GitHub repo → **Releases → Draft a new release**
2. **Choose a tag** → type `v1.0-models` → Create new tag
3. **Release title**: `Model Assets v1.0`
4. **Description**:
   ```
   Stacked sentence-transformer embeddings for KJV, AMP, NIV, ESV, NKJV, NASB.
   Generated with all-MiniLM-L6-v2. Shape: (186612, 384), float32, L2-normalized.
   ```
5. **Attach files** → drag in `all_versions_embeddings.npy`
6. Check **Set as a pre-release** (it's a model asset, not an app release)
7. Click **Publish release**

> The GitHub Actions workflow downloads this file automatically on every build
> using `gh release download v1.0-models`.

---

## Step 4 — For Local Development

To run the app locally you also need the files in place:

```bash
# Download super_bible.db (59 MB)
curl -L "https://raw.githubusercontent.com/alshival/super_bible/main/SUPER_BIBLE/super_bible.db" \
  -o desktop-rs/src-tauri/bible_data/super_bible.db

# Place all_versions_embeddings.npy (from Colab download)
cp ~/Downloads/all_versions_embeddings.npy \
  desktop-rs/src-tauri/bible_data/all_versions_embeddings.npy

# verse_index.json is already in the repo after Step 2
```

Then run as normal:
```bash
cd desktop-rs
npm run tauri dev
```

---

## Versions Available

| Version | Full Name | In DB |
|---|---|---|
| KJV | King James Version | Yes |
| AMP | Amplified Bible | Yes |
| NIV | New International Version | Yes |
| ESV | English Standard Version | Yes |
| NKJV | New King James Version | Yes |
| NASB | New American Standard Bible | Yes |
| ASV | American Standard Version | Yes (not embedded) |
| WEB | World English Bible | Yes (not embedded) |
| YLT | Young's Literal Translation | Yes (not embedded) |

> NLT and MSG are **not** in the database (copyrighted, no open-source version available).

To add more versions to the embeddings, edit `VERSIONS` in:
- `scripts/generate_embeddings_colab.ipynb` (Cell 4)
- `src-tauri/src/store/mod.rs` → `EMBEDDED_VERSIONS` constant

---

## How It Works

### Semantic Auto-Detection
When the microphone picks up speech, the transcription is embedded and compared
against the **stacked embeddings matrix** (all 6 versions × 31,102 verses = ~186k rows).

This means if a preacher quotes NIV phrasing, the NIV row scores highest — even if
the display version is set to KJV. The detected `(book, chapter, verse)` is then
looked up in the active display version.

### Version Switching
- UI: version pill buttons at the top of the Bible tab
- Switching updates both the display queries and the active version in the Rust store
- The transcription pipeline always searches all versions simultaneously

### Database Schema
```sql
-- super_bible table
SELECT title, chapter, verse, text
FROM super_bible
WHERE version = 'KJV' AND language = 'EN'
ORDER BY book, chapter, verse
```

---

## Troubleshooting

**App crashes at startup**
- `super_bible.db` is missing from `src-tauri/bible_data/`
- Run the curl command in Step 4

**Version selector shows only "KJV"**
- `super_bible.db` is present but may be the old single-version `bible.db`
- Check: `sqlite3 bible_data/super_bible.db "SELECT DISTINCT version FROM super_bible LIMIT 5"`

**Semantic search not working**
- `all_versions_embeddings.npy` is missing
- Generate it via Colab (Step 1) — the app still works without it, just no auto-detection

**Build fails: `all_versions_embeddings.npy` not found**
- The GitHub Release `v1.0-models` hasn't been created yet
- Complete Step 3 before pushing to main
