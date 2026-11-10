# AI Scripture evaluation corpus

`synthetic.jsonl` is a small, non-sensitive regression corpus for the deterministic reference parser and direct-quotation aligner. Run it with:

```powershell
npm run ai:eval
```

Each JSONL record is either:

- `reference`: transcript plus an expected canonical reference or `null` for a hard negative.
- `quote`: transcript, candidate verse texts, and the expected winning canonical reference or `null`.

The CLI reports precision, recall, F1, exact-result accuracy, and local detector p95 latency. It exits unsuccessfully below the checked-in thresholds (reference precision/recall `0.99/0.90`; quotation precision/recall `0.90/0.80`), making it suitable for CI. This measures deterministic detection only—not Deepgram word-error rate or network latency.

## Paraphrase quality probe

`paraphrase.jsonl` drives an offline probe for the semantic (paraphrase) engine. It is a manual quality gate — it requires two fixtures that are deliberately not committed:

1. **Model fixture**: the pinned `Xenova/bge-base-en-v1.5` files (revision `4d6cd88e18e51a5e020c2c305726d76ada9c03cf`). Place `model_quantized.onnx`, `tokenizer.json`, `config.json`, `special_tokens_map.json`, and `tokenizer_config.json` under `%TEMP%\opencode\bge-base-pin`, or point `WORDLYTE_TEST_BGE_MODEL` at that folder.
2. **Index fixture**: a semantic index over the installed **WEB** corpus at the same model revision, in gitignored `src-tauri/bible_data/`. Rebuild it with the in-repo builder (defaults to the operator database under `%LOCALAPPDATA%\io.wordlyte.app\bible_data\wordlyte_bible.db`; override with `WORDLYTE_TEST_BIBLE_DB`):

```powershell
cargo test --lib builds_probe_index_fixture -- --ignored --nocapture
```

Then run:

```powershell
cargo test --lib bundled_index_quality_probe -- --ignored --nocapture
```

The probe asserts the conservative gate accepts no hard negative, keeps p95 latency under 3 s, and enforces recalled-hit floors calibrated against the pinned fixtures. Failures mean a model, index, or ranking change degraded retrieval quality; re-run the summary line above and recalibrate the floors deliberately rather than silencing them.

### Hybrid rerank harness

Dense retrieval is no longer the shipped ranking path: production adds lexical FTS candidates and re-ranks the pool with a pinned `Xenova/ms-marco-MiniLM-L-6-v2` cross-encoder. That path has its own harness, which also needs the reranker fixture:

3. **Reranker fixture**: the pinned reranker files (revision `a09144355adeed5f58c8ed011d209bf8ee5a1fec`) in a flat folder — `model_quantized.onnx`, `tokenizer.json`, `config.json`, `special_tokens_map.json`, `tokenizer_config.json` — e.g. `%TEMP%\opencode\reranker-pin`, or point `WORDLYTE_TEST_RERANKER_MODEL` at it.

```powershell
cargo test --lib evaluates_reranker_candidates -- --ignored --nocapture
```

It mirrors production candidate assembly, blending (`BLEND_DENSE_WEIGHT`), and the `MIN_RERANK_SIMILARITY` gate, and asserts proportional coverage, reranked top-1 and top-3 floors plus zero hard-negative accepts. Current measured baseline on the 100-record set (71 positives / 29 negatives): coverage 66/71, top-1 51/71 (dense-only 43/71), top-3 60/71, 0 hard negatives accepted.

Two optional environment overrides support embedder comparisons without disturbing the default fixture:

- `WORDLYTE_TEST_INDEX_PATH` — evaluate a different index (for example a 384-dim bge-small build) while `WORDLYTE_TEST_BGE_MODEL` points at the matching flat model files. Index headers are dimension-agnostic; production validates the header dimension against the warmed embedder.
- `WORDLYTE_TEST_BLEND_WEIGHT` — sweep the dense weight (`0.0` is rerank-only, `1.0` is dense-only) instead of the compiled `BLEND_DENSE_WEIGHT`.

### Embedder comparison (original 22-positive set)

`Xenova/bge-small-en-v1.5` (revision `ea104dacec62c0de699686887e3f920caeb4f3e3`) was measured as a smaller alternative: 384 dims, 17.8 MB index, 34 MB ONNX instead of 768 dims, 34.9 MB and 120 MB.

| Configuration | Coverage | Dense top-1 | Reranked top-1 | Top-3 | Accepted wrong | False accepts |
| --- | --- | --- | --- | --- | --- | --- |
| bge-small, blend 0.0 | 21/22 | 12/22 | 15/22 | 20/22 | 5 | 0 |
| bge-small, blend 0.25 | 21/22 | 12/22 | 16/22 | 19/22 | 5 | 0 |
| bge-small, blend 0.40 | 21/22 | 12/22 | 13/22 | 18/22 | 6 | 0 |
| **bge-base, blend 0.25 (shipped)** | 21/22 | 13/22 | **17/22** | **21/22** | **3** | 0 |

bge-small keeps every hard negative out and loses nothing in hybrid coverage, but it gives up two reranked top-1s and two top-3s, and admits two more near-miss suggestions. Dense latency improves roughly 33% (925 ms vs 1370 ms dense p95). It is therefore documented as a fallback for download-size pressure, not the shipped default.

## Private sermon corpus

Do not commit sermon audio, raw transcripts, speaker names, or congregation data. Place consented and de-identified local material under `evaluation/ai-scripture/private/`, which is gitignored. Track consent, permitted uses, retention, and deletion outside this repository. Aggregate measurements may be copied into an approved report only after privacy review.
