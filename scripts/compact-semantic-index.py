#!/usr/bin/env python3
"""Compact Wordlyte's legacy per-translation USearch vectors.

The source index was generated with BAAI/bge-small-en-v1.5 and contains one
float32 vector per verse translation. This tool averages installed English
translation vectors by canonical reference, normalizes the result, quantizes
it to signed int8, and writes Wordlyte's small read-only runtime format.

Example:
    python scripts/compact-semantic-index.py \
      --source-index C:/bible_data/all_versions_embeddings.usearch \
      --metadata C:/bible_data/verse_index.json \
      --db C:/bible_data/wordlyte_bible.db \
      --out src-tauri/bible_data/bible-semantic-bge-v1.index
"""

import argparse
import hashlib
import json
import sqlite3
import struct
from pathlib import Path

import numpy as np
from usearch.index import Index

MAGIC = b"WLYSEM02"
DIMENSION = 384
MODEL_REVISION = "ea104dacec62c0de699686887e3f920caeb4f3e3"
EXPECTED_SOURCE_SHA256 = "bc9dba07234ce9d37baf232ce83f7b3e2929972c812f234ee740ec152550b0a3"
EXPECTED_METADATA_SHA256 = "80946fe58b13e69947be51db4d3e8f7c74e9014005a5e020e02084adbacdc9ae"
EXPECTED_CORPUS_FINGERPRINT = "2637ddcdb8dc49c16e0b86eb8644efb197b4389d48d291641f16cc787c859e91"
EXPECTED_OUTPUT_SHA256 = "a541018334369d5a41212e4bbccc8738dad472f64345d8c95e6bc7e0a22db4ec"


def verify_sha256(path: Path, expected: str) -> None:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    actual = digest.hexdigest()
    if actual != expected:
        raise ValueError(f"unverified input {path}: expected {expected}, got {actual}")


def canonical_corpus(connection: sqlite3.Connection):
    return connection.execute(
        """
        SELECT title, chapter, verse, GROUP_CONCAT(text, '\n')
        FROM (
            SELECT title, book, chapter, verse, text, version
            FROM wordlyte_bible
            WHERE language = 'EN' AND text IS NOT NULL AND text != ''
            ORDER BY book, chapter, verse, version
        )
        GROUP BY book, title, chapter, verse
        ORDER BY book, chapter, verse
        """
    ).fetchall()


def corpus_fingerprint(rows) -> bytes:
    digest = hashlib.sha256()
    digest.update(MODEL_REVISION.encode("utf-8"))
    digest.update(b"\xfe")
    for book, chapter, verse, text in rows:
        digest.update(book.encode("utf-8"))
        digest.update(b"\0")
        digest.update(struct.pack("<i", chapter))
        digest.update(struct.pack("<i", verse))
        digest.update(text.encode("utf-8"))
        digest.update(b"\xff")
    return digest.digest()


def compact(source_index: Path, metadata_path: Path, db_path: Path, output: Path):
    verify_sha256(source_index, EXPECTED_SOURCE_SHA256)
    verify_sha256(metadata_path, EXPECTED_METADATA_SHA256)
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    source = Index.restore(str(source_index))
    if source.ndim != DIMENSION or source.size != len(metadata):
        raise ValueError(
            f"source mismatch: index={source.size}x{source.ndim}, metadata={len(metadata)}"
        )

    connection = sqlite3.connect(db_path)
    corpus = canonical_corpus(connection)
    connection.close()
    fingerprint = corpus_fingerprint(corpus)
    if fingerprint.hex() != EXPECTED_CORPUS_FINGERPRINT:
        raise ValueError(
            "Bible corpus does not match the pinned semantic-index source: "
            f"expected {EXPECTED_CORPUS_FINGERPRINT}, got {fingerprint.hex()}"
        )
    entries = [(book, int(chapter), int(verse)) for book, chapter, verse, _ in corpus]
    positions = {entry: index for index, entry in enumerate(entries)}
    sums = np.zeros((len(entries), DIMENSION), dtype=np.float32)
    counts = np.zeros(len(entries), dtype=np.uint8)

    batch_size = 4096
    for start in range(0, len(metadata), batch_size):
        stop = min(start + batch_size, len(metadata))
        vectors = np.stack(source.get(np.arange(start, stop, dtype=np.uint64)))
        destination = np.fromiter(
            (
                positions[(item["book"], int(item["chapter"]), int(item["verse"]))]
                for item in metadata[start:stop]
            ),
            dtype=np.int64,
            count=stop - start,
        )
        np.add.at(sums, destination, vectors)
        np.add.at(counts, destination, 1)
        print(f"Combined {stop}/{len(metadata)} translation vectors")

    if np.any(counts == 0):
        raise ValueError("source index does not cover every canonical Bible verse")
    averages = sums / counts[:, None]
    norms = np.linalg.norm(averages, axis=1, keepdims=True)
    normalized = averages / np.maximum(norms, np.finfo(np.float32).eps)
    quantized = np.rint(np.clip(normalized, -1.0, 1.0) * 127.0).astype(np.int8)

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".part")
    with temporary.open("wb") as file:
        file.write(MAGIC)
        file.write(fingerprint)
        file.write(struct.pack("<I", DIMENSION))
        file.write(struct.pack("<I", len(entries)))
        for (book, chapter, verse), vector in zip(entries, quantized):
            encoded_book = book.encode("utf-8")
            file.write(struct.pack("<H", len(encoded_book)))
            file.write(encoded_book)
            file.write(struct.pack("<ii", chapter, verse))
            file.write(vector.tobytes())
    temporary.replace(output)
    sha256 = hashlib.sha256(output.read_bytes()).hexdigest()
    if sha256 != EXPECTED_OUTPUT_SHA256:
        output.unlink(missing_ok=True)
        raise ValueError(
            f"generated output is not reproducible: expected {EXPECTED_OUTPUT_SHA256}, got {sha256}"
        )
    print(f"Wrote {output} ({output.stat().st_size} bytes, SHA-256 {sha256})")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-index", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    compact(args.source_index, args.metadata, args.db, args.out)


if __name__ == "__main__":
    main()
