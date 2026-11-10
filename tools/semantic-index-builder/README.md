# Pre-built semantic index builder (Google Colab)

`build_prebuilt_indexes.py` produces the release asset
`bible-semantic-bge-base-v1.zip` — pre-built paraphrase indexes for NKJV, ASV,
WEB, NIV, and AMP — so operators download the bundle during paraphrase
preparation instead of embedding ~232k passages on the church machine (which
would take hours on CPU).

## Why this exists

Preparation on-device embeds every verse plus overlapping 4-verse windows per
translation with `bge-base-en-v1.5` (768-dim). On a typical operator machine
that is roughly an hour **per translation**. The Colab script does the same
work once on Colab (GPU runtime ≈ 1–3 hours total for all five), and the app's
prepare flow then:

1. Downloads `bible-semantic-bge-base-v1.zip` from the latest GitHub release.
2. For each installed translation, parses the bundle's index entry, checks the
   header (`WLYSEM04`, 768-dim), and compares its corpus fingerprint against a
   fingerprint computed from the operator's own installed Bible text.
3. Installs matching entries atomically; any version that is missing,
   unreadable, or fingerprint-mismatched is still embedded locally, so a
   stale bundle can never corrupt retrieval.

The fingerprint (SHA-256 over the model revision + every corpus verse) makes
the bundle safe: it only ever installs indexes whose text matches the
operator's database exactly.

## Running it

Two equivalent entry points; the notebook is generated from the script by
`make_notebook.py`, so the pins cannot drift:

- **Notebook (recommended)**: upload `build_prebuilt_indexes.ipynb` to
  [colab.research.google.com](https://colab.research.google.com) and use
  *Runtime → Run all*. It splits the script into one cell per step for
  incremental output.
- **Script**: create a notebook and paste all of `build_prebuilt_indexes.py`
  into one cell and run it.

Either way:

1. Set *Runtime → Change runtime type → T4 GPU* (CPU works but is ~10× slower).
2. The script handles pip installs, model download, and checksum verification.
3. Bible source (in order of preference):
   - the `wordlyte_bible.zip` release asset, downloaded automatically;
   - otherwise a file-upload prompt for `wordlyte_bible.db`.
4. When it finishes, Colab offers the bundle for download. It is also at
   `/content/bible-semantic-bge-base-v1.zip`, and a `manifest.json` inside the
   zip lists each index's SHA-256 for reference.

Re-running the cell is safe: finished indexes are cached in
`/content/semantic-cache` and skipped when their fingerprint still matches.

## Publishing the bundle

```powershell
gh release upload <tag> bible-semantic-bge-base-v1.zip --clobber
```

The app resolves
`https://github.com/Niceiyke/bible-presenter/releases/latest/download/bible-semantic-bge-base-v1.zip`,
so uploading to the **latest** release is what makes operators find it.
Bundle size is ~180 MB (deflated from ~230 MB of raw indexes); the app refuses
bundles over 512 MB.

## When the bundle must be rebuilt

- The pinned model revision in `src-tauri/src/semantic_scripture.rs` changes
  (fingerprints include the revision, so old bundles stop matching).
- The corpus pipeline changes (`semantic_documents`, the fingerprint layout,
  `WLYSEM04` format, or the builder's `EMBEDDING_DIMENSION`).
- A translation's text in the shipped `wordlyte_bible.db` changes.

Keep the pins at the top of the script in sync with
`src-tauri/src/semantic_scripture.rs`; the script asserts the model-file
SHA-256 hashes so a drift is caught immediately.

`build_prebuilt_indexes.ipynb` is generated — edit the `.py` and run
`python tools/semantic-index-builder/make_notebook.py` (it fails if the
generated cells do not reconstruct the script exactly).
