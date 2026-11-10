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

## Private sermon corpus

Do not commit sermon audio, raw transcripts, speaker names, or congregation data. Place consented and de-identified local material under `evaluation/ai-scripture/private/`, which is gitignored. Track consent, permitted uses, retention, and deletion outside this repository. Aggregate measurements may be copied into an approved report only after privacy review.
