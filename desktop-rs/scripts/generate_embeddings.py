#!/usr/bin/env python3
"""
Generate stacked sentence-transformer embeddings for multiple Bible versions.

Usage:
    pip install sentence-transformers numpy
    python scripts/generate_embeddings.py \
        --db path/to/super_bible.db \
        --out src-tauri/bible_data/

This produces:
    all_versions_embeddings.npy  — float32 array (N_total_verses, 384), L2-normalized
    verse_index.json             — list of {book, chapter, verse, version} matching each row

The row order is: all verses of VERSION_1 (sorted by book/chapter/verse),
then all of VERSION_2, etc. This matches exactly how BibleStore loads
verse_cache (all versions in order), so embeddings[i] == verse_cache[i].
"""

import argparse
import json
import sqlite3
import sys
from pathlib import Path

import numpy as np

VERSIONS = ["KJV", "AMP", "NIV", "ESV", "NKJV", "NASB"]


def generate(db_path: str, out_dir: str) -> None:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        print("ERROR: sentence-transformers not installed.")
        print("  pip install sentence-transformers")
        sys.exit(1)

    print("Loading model all-MiniLM-L6-v2 ...")
    model = SentenceTransformer("all-MiniLM-L6-v2")

    conn = sqlite3.connect(db_path)

    # Detect which of our desired versions actually exist in the DB
    available = {
        row[0]
        for row in conn.execute(
            "SELECT DISTINCT version FROM super_bible WHERE language = 'EN'"
        )
    }
    versions_to_use = [v for v in VERSIONS if v in available]
    missing = [v for v in VERSIONS if v not in available]
    if missing:
        print(f"WARNING: versions not found in DB, skipping: {missing}")
    print(f"Versions to embed: {versions_to_use}")

    all_embeddings = []
    verse_index = []

    for version in versions_to_use:
        print(f"\n--- {version} ---")
        rows = conn.execute(
            """
            SELECT title, chapter, verse, text
            FROM super_bible
            WHERE version = ? AND language = 'EN'
            ORDER BY book, chapter, verse
            """,
            (version,),
        ).fetchall()

        if not rows:
            print(f"  No rows found for {version}, skipping.")
            continue

        print(f"  {len(rows)} verses")
        texts = [r[3] for r in rows]

        embeddings = model.encode(
            texts,
            normalize_embeddings=True,
            batch_size=512,
            show_progress_bar=True,
            convert_to_numpy=True,
        )  # shape: (N, 384)

        all_embeddings.append(embeddings.astype(np.float32))

        for r in rows:
            verse_index.append(
                {"book": r[0], "chapter": int(r[1]), "verse": int(r[2]), "version": version}
            )

    if not all_embeddings:
        print("ERROR: No embeddings generated.")
        sys.exit(1)

    stacked = np.vstack(all_embeddings)  # (N_total, 384)
    print(f"\nStacked matrix shape: {stacked.shape}")

    npy_path = out / "all_versions_embeddings.npy"
    idx_path = out / "verse_index.json"

    np.save(str(npy_path), stacked)
    print(f"Saved embeddings → {npy_path}")

    with open(idx_path, "w") as f:
        json.dump(verse_index, f, separators=(",", ":"))
    print(f"Saved verse index → {idx_path}")

    conn.close()
    print("\nDone.")


def main():
    parser = argparse.ArgumentParser(description="Generate stacked Bible embeddings")
    parser.add_argument(
        "--db",
        default="src-tauri/bible_data/super_bible.db",
        help="Path to super_bible.db (default: src-tauri/bible_data/super_bible.db)",
    )
    parser.add_argument(
        "--out",
        default="src-tauri/bible_data",
        help="Output directory (default: src-tauri/bible_data)",
    )
    args = parser.parse_args()
    generate(args.db, args.out)


if __name__ == "__main__":
    main()
