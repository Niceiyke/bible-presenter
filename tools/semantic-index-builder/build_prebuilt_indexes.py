"""Builds the pre-built semantic index bundle for Wordlyte Pro in Google Colab.

Paste this ENTIRE file into one Colab cell and run it. It:

1. Downloads the pinned Xenova/bge-base-en-v1.5 model files (revision-pinned,
   SHA256-verified — identical pins to src-tauri/src/semantic_scripture.rs).
2. Downloads wordlyte_bible.zip from the pinned release tag that the app itself
   uses (same URL and SHA-256 as src-tauri/src/commands/assets.rs). If the
   asset is unavailable, it asks you to upload a wordlyte_bible.db instead.
3. For each supported translation (NKJV, ASV, WEB, NIV, AMP) it replicates the
   Rust pipeline exactly: corpus SQL, per-verse + overlapping 4-verse window
   documents, corpus fingerprint, CLS pooling, L2 normalization, i8
   quantization (round half away from zero, matching Rust f32::round), and the
   WLYSEM04 binary index format.
4. Verifies every index it writes by parsing it back, then zips them into
   `bible-semantic-bge-base-v1.zip` — the file name the app downloads from
   GitHub releases — together with a manifest.json for debugging.

Output: /content/bible-semantic-bge-base-v1.zip (~180 MB). Upload it as a
release asset (`gh release upload <tag> bible-semantic-bge-base-v1.zip` or the
GitHub web UI). The app validates each entry's fingerprint against its own
installed Bible text before trusting it, so a bundle built from a stale DB is
silently rejected per-version and those versions build locally instead.

Runtime notes:
- GPU runtime recommended (Runtime > Change runtime type > T4). The script
  installs onnxruntime-gpu automatically when CUDA is available; the quantized
  ONNX still runs correctly on a CPU runtime, just much slower.
- Re-running is safe: finished indexes are cached in /content/semantic-cache
  and skipped when their fingerprint matches.
"""

import hashlib
import json
import os
import struct
import subprocess
import sys
import time
import urllib.request
import zipfile

# ---------------------------------------------------------------------------
# Pins — keep in sync with src-tauri/src/semantic_scripture.rs
# ---------------------------------------------------------------------------
MODEL_REPOSITORY = "Xenova/bge-base-en-v1.5"
MODEL_REVISION = "4d6cd88e18e51a5e020c2c305726d76ada9c03cf"
EMBEDDING_DIMENSION = 768
MAX_LENGTH = 256
# 32 left the GPU mostly idle. T4 memory comfortably handles 128 passages at
# the 256-token limit; CPU-only Colab still benefits from fewer session calls.
BATCH_SIZE = 128
INDEX_MAGIC = b"WLYSEM04"
INDEX_FILE_BASE = "bible-semantic-bge-base-v1"
SEMANTIC_INDEX_VERSIONS = ["NKJV", "ASV", "WEB", "NIV", "AMP"]
BUNDLE_NAME = "bible-semantic-bge-base-v1.zip"
BIBLE_DB_RELEASE_URL = (
    "https://github.com/Niceiyke/bible-presenter/releases/download/v2.0.0/wordlyte_bible.zip"
)
# Pinned to the same asset the app downloads (src-tauri/src/commands/assets.rs).
# `releases/latest/` is deliberately avoided: newer releases may not carry this
# asset, and a changed DB silently invalidates every cached index fingerprint.
BIBLE_DATA_ZIP_SHA256 = "3d05357e5d292b74547c544d2a78d58ce7cf1529d2df888de002d00f0c211281"
MODEL_FILES = {
    "onnx/model_quantized.onnx": "c9729cc84cbd0e9fecc759505d2be65916c9fe05222d7ea26c65fcb3382af38d",
    "tokenizer.json": "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
    "config.json": "d83c21fa7366994560727112ef0a31d8a2ec1c280c2a3e66326fdb877f64c91e",
    "special_tokens_map.json": "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3",
    "tokenizer_config.json": "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
}

WORK = "/content/wordlyte-index-build"
CACHE = os.path.join(WORK, "semantic-cache")
os.makedirs(CACHE, exist_ok=True)

# ---------------------------------------------------------------------------
# Step 1 — dependencies (Colab: paste-and-run handles pip itself)
# ---------------------------------------------------------------------------
print("Installing Python dependencies...")
try:
    import torch

    HAS_CUDA = torch.cuda.is_available()
except Exception:
    HAS_CUDA = False

# Installing the CPU and GPU wheels together can leave the CPU module first on
# sys.path, which silently makes step 6 run on the CPU. Pick one runtime.
subprocess.run(
    [sys.executable, "-m", "pip", "uninstall", "-y", "onnxruntime", "onnxruntime-gpu"],
    check=False,
)
runtime_package = "onnxruntime-gpu" if HAS_CUDA else "onnxruntime"
try:
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "-q", runtime_package, "tokenizers"],
        check=True,
    )
except subprocess.CalledProcessError:
    if not HAS_CUDA:
        raise
    print("GPU runtime install failed; falling back to CPU.")
    HAS_CUDA = False
    runtime_package = "onnxruntime"
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "-q", runtime_package, "tokenizers"],
        check=True,
    )
print(f"Embedding runtime: {runtime_package} (CUDA available: {HAS_CUDA})")


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


# ---------------------------------------------------------------------------
# Step 2 — pinned model files
# ---------------------------------------------------------------------------
print(f"Downloading pinned model files (revision {MODEL_REVISION[:12]}…)…")
from huggingface_hub import snapshot_download

model_dir = snapshot_download(
    repo_id=MODEL_REPOSITORY,
    revision=MODEL_REVISION,
    allow_patterns=list(MODEL_FILES.keys()),
    local_dir=os.path.join(WORK, "model"),
)
for relative, expected in MODEL_FILES.items():
    local = os.path.join(model_dir, relative)
    actual = sha256_file(local)
    assert actual == expected, f"SHA256 mismatch for {relative}: {actual}"
print("Model files verified against the pinned SHA256 hashes.")

# ---------------------------------------------------------------------------
# Step 3 — Bible database (release asset, else manual upload)
# ---------------------------------------------------------------------------
db_path = os.path.join(WORK, "wordlyte_bible.db")
if not os.path.exists(db_path):
    print("Downloading the pinned wordlyte_bible.zip release asset…")
    try:
        zip_path = os.path.join(WORK, "wordlyte_bible.zip")
        urllib.request.urlretrieve(BIBLE_DB_RELEASE_URL, zip_path)
        actual = sha256_file(zip_path)
        assert actual == BIBLE_DATA_ZIP_SHA256, f"wordlyte_bible.zip SHA256 mismatch: {actual}"
        with zipfile.ZipFile(zip_path) as archive:
            member = next(name for name in archive.namelist() if name.endswith(".db"))
            archive.extract(member, WORK)
            os.rename(os.path.join(WORK, member), db_path)
        print("Bible database verified against the pinned SHA256.")
    except Exception as error:
        print(f"Release asset unavailable ({error}). Upload wordlyte_bible.db below.")
        from google.colab import files

        uploaded = files.upload()
        name = next(iter(uploaded))
        open(db_path, "wb").write(uploaded[name])
print(f"Bible database ready: {db_path}")

# ---------------------------------------------------------------------------
# Step 4 — pipeline functions (mirror semantic_scripture.rs exactly)
# ---------------------------------------------------------------------------
import numpy as np
import onnxruntime as ort
import sqlite3
from tokenizers import Tokenizer


def semantic_corpus(version):
    """Same SQL semantics as BibleStore::semantic_corpus: rows ordered by the
    internal `book` column, but the displayed `title` becomes the entry name."""
    connection = sqlite3.connect(db_path)
    try:
        rows = connection.execute(
            "SELECT title, chapter, verse, text "
            "FROM wordlyte_bible "
            "WHERE language = 'EN' AND version = ? AND text IS NOT NULL AND text != '' "
            "ORDER BY book, chapter, verse",
            (version,),
        ).fetchall()
    finally:
        connection.close()
    return [{"book": r[0], "chapter": r[1], "verse": r[2], "text": r[3]} for r in rows]


def semantic_documents(corpus):
    """Verse documents plus overlapping 4-verse windows (step 2, no chapter
    crossing) — mirrors semantic_documents() in semantic_scripture.rs."""
    documents = [
        {"book": v["book"], "chapter": v["chapter"], "verse": v["verse"], "verse_end": v["verse"], "text": v["text"]}
        for v in corpus
    ]
    index = 0
    while index < len(corpus):
        first = corpus[index]
        end = index + 1
        while end < len(corpus) and corpus[end]["book"] == first["book"] and corpus[end]["chapter"] == first["chapter"]:
            end += 1
        chapter = corpus[index:end]
        for start in range(0, len(chapter), 2):
            stop = min(start + 4, len(chapter))
            window = chapter[start:stop]
            if len(window) < 2 or not all(
                verse["verse"] == window[0]["verse"] + offset for offset, verse in enumerate(window)
            ):
                continue
            documents.append(
                {
                    "book": first["book"],
                    "chapter": first["chapter"],
                    "verse": window[0]["verse"],
                    "verse_end": window[-1]["verse"],
                    "text": " ".join(verse["text"] for verse in window),
                }
            )
        index = end
    return documents


def corpus_fingerprint(corpus):
    """Byte-for-byte match with corpus_fingerprint() in semantic_scripture.rs."""
    hasher = hashlib.sha256()
    hasher.update(MODEL_REVISION.encode("utf-8"))
    hasher.update(b"\xfe")
    for item in corpus:
        hasher.update(item["book"].encode("utf-8"))
        hasher.update(b"\x00")
        hasher.update(struct.pack("<i", item["chapter"]))
        hasher.update(struct.pack("<i", item["verse"]))
        hasher.update(item["text"].encode("utf-8"))
        hasher.update(b"\xff")
    return hasher.digest()


def read_index_header(path):
    """Returns (fingerprint, dimension, count) or None for an invalid file."""
    try:
        with open(path, "rb") as handle:
            if handle.read(8) != INDEX_MAGIC:
                return None
            fingerprint = handle.read(32)
            dimension, count = struct.unpack("<II", handle.read(8))
            if dimension != EMBEDDING_DIMENSION or count == 0:
                return None
            return fingerprint, dimension, count
    except OSError:
        return None


def write_index(path, fingerprint, documents, vectors):
    """WLYSEM04 layout: magic(8) fingerprint(32) dimension(u32 LE) count(u32 LE)
    then per entry: book_len(u16 LE) book(utf8) chapter(i32) verse(i32)
    verse_end(i32) + dimension bytes of i8 (little-endian, one per dim)."""
    with open(path, "wb") as handle:
        handle.write(INDEX_MAGIC)
        handle.write(fingerprint)
        handle.write(struct.pack("<I", EMBEDDING_DIMENSION))
        handle.write(struct.pack("<I", len(documents)))
        for document, vector in zip(documents, vectors):
            book = document["book"].encode("utf-8")
            handle.write(struct.pack("<H", len(book)))
            handle.write(book)
            handle.write(struct.pack("<iii", document["chapter"], document["verse"], document["verse_end"]))
            handle.write(np.clip(vector, -127, 127).astype(np.int8).tobytes())


# ---------------------------------------------------------------------------
# Step 5 — the embedding session
# ---------------------------------------------------------------------------
tokenizer = Tokenizer.from_file(os.path.join(model_dir, "tokenizer.json"))
tokenizer.enable_truncation(max_length=MAX_LENGTH)
tokenizer.enable_padding()  # longest-in-batch, like fastembed

providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if HAS_CUDA else ["CPUExecutionProvider"]
print(f"ONNX Runtime providers available: {ort.get_available_providers()}")
session = ort.InferenceSession(os.path.join(model_dir, "onnx", "model_quantized.onnx"), providers=providers)
print(f"ONNX session providers: {session.get_providers()}")
if HAS_CUDA and "CUDAExecutionProvider" not in session.get_providers():
    print("WARNING: CUDA is available but this session fell back to CPU. Step 6 will be much slower.")


def embed_batch(texts):
    """CLS pooling + L2 normalization, matching fastembed Cls/Dynamic. The i8
    quantization uses round-half-away-from-zero to match Rust f32::round."""
    encodings = tokenizer.encode_batch(texts)
    available = {
        "input_ids": np.array([e.ids for e in encodings], dtype=np.int64),
        "attention_mask": np.array([e.attention_mask for e in encodings], dtype=np.int64),
        "token_type_ids": np.array([e.type_ids for e in encodings], dtype=np.int64),
    }
    feeds = {i.name: available[i.name] for i in session.get_inputs() if i.name in available}
    missing = [i.name for i in session.get_inputs() if i.name not in available]
    assert not missing, f"unexpected model inputs: {missing}"
    hidden = session.run(None, feeds)[0]
    pooled = hidden[:, 0, :].astype(np.float32)  # [CLS]
    magnitude = np.sqrt(np.sum(pooled * pooled, axis=1, dtype=np.float32)).astype(np.float32)
    magnitude[magnitude == 0] = 1.0
    normalized = (pooled / magnitude[:, None]).astype(np.float32)
    scaled = normalized * np.float32(127.0)
    quantized = np.sign(scaled) * np.floor(np.abs(scaled) + np.float32(0.5))
    return quantized


def build_version(version):
    corpus = semantic_corpus(version)
    if not corpus:
        print(f"{version}: not installed in this database — skipped.")
        return None
    fingerprint = corpus_fingerprint(corpus)
    target = os.path.join(CACHE, f"{INDEX_FILE_BASE}-{version}.index")
    cached = read_index_header(target)
    if cached and cached[0] == fingerprint and cached[2] == len(semantic_documents(corpus)):
        print(f"{version}: cached index already matches fingerprint {fingerprint.hex()[:16]}…")
        return target

    documents = semantic_documents(corpus)
    vectors = np.empty((len(documents), EMBEDDING_DIMENSION), dtype=np.float32)
    # Batches are padded to the longest passage they contain. Sorting by text
    # length keeps short verses together and long windows together, which cuts
    # wasted attention work substantially. Vectors are written back by their
    # original index, so the on-disk entry order is unchanged.
    order = sorted(range(len(documents)), key=lambda index: len(documents[index]["text"]))
    started = time.time()
    for start in range(0, len(order), BATCH_SIZE):
        positions = order[start : start + BATCH_SIZE]
        batch = [documents[index] for index in positions]
        vectors[positions] = embed_batch([document["text"] for document in batch])
        if (start // BATCH_SIZE) % 50 == 0:
            elapsed = max(time.time() - started, 1.0)
            rate = (start + len(positions)) / elapsed
            remaining = (len(order) - start - len(positions)) / max(rate, 1.0)
            print(f"{version}: {start + len(positions)}/{len(order)} ({rate:.1f} docs/s, ~{remaining/60:.0f} min left)")
    print(f"{version}: embedding finished in {(time.time() - started)/60:.1f} min")
    write_index(target, fingerprint, documents, vectors)
    # Parse it back the way the app will: header, entry layout, byte count.
    header = read_index_header(target)
    assert header and header[0] == fingerprint, f"{version}: written index failed verification"
    expected_size = 8 + 32 + 8 + len(documents) * (2 + EMBEDDING_DIMENSION + 12)
    actual_size = os.path.getsize(target)
    assert actual_size == expected_size, f"{version}: index size {actual_size} != {expected_size}"
    return target


# ---------------------------------------------------------------------------
# Step 6 — build every version, then bundle
# ---------------------------------------------------------------------------
# Set WORDLYTE_SEMANTIC_VERSIONS=NKJV for a quick test bundle (KJV projects
# from the NKJV index). Leave unset for the full release bundle.
requested_versions = os.environ.get("WORDLYTE_SEMANTIC_VERSIONS")
versions_to_build = (
    [version.strip().upper() for version in requested_versions.split(",") if version.strip()]
    if requested_versions
    else SEMANTIC_INDEX_VERSIONS
)
unknown_versions = [version for version in versions_to_build if version not in SEMANTIC_INDEX_VERSIONS]
assert not unknown_versions, f"unsupported semantic versions: {unknown_versions}"

built = {}
for version in versions_to_build:
    path = build_version(version)
    if path:
        built[version] = path
assert built, "none of the selected translations are installed in this database"

bundle_path = os.path.join("/content", BUNDLE_NAME)
manifest = {
    "modelRepository": MODEL_REPOSITORY,
    "modelRevision": MODEL_REVISION,
    "format": "WLYSEM04",
    "dimension": EMBEDDING_DIMENSION,
    "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "indexes": {
        version: {
            "file": os.path.basename(path),
            "sha256": sha256_file(path),
            "sizeBytes": os.path.getsize(path),
        }
        for version, path in built.items()
    },
}
# Index payloads are already int8 vectors, so deflate spends minutes for almost
# no size reduction. Store them directly so the bundle step finishes quickly.
with zipfile.ZipFile(bundle_path, "w", compression=zipfile.ZIP_STORED) as archive:
    for path in built.values():
        archive.write(path, os.path.basename(path))
    archive.writestr("manifest.json", json.dumps(manifest, indent=2))

print("\n=== BUNDLE READY ===")
print(json.dumps(manifest, indent=2))
print(f"\nbundle: {bundle_path} ({os.path.getsize(bundle_path)/1024/1024:.1f} MB)")
print("Upload it as a release asset so PREBUILT_BUNDLE_URL resolves, e.g.:")
print(f"  gh release upload <tag> {BUNDLE_NAME} --clobber")
try:
    from google.colab import files

    files.download(bundle_path)
except ImportError:
    print("(not running inside Colab — download the bundle manually)")
