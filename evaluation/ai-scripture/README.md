# AI Scripture evaluation corpus

`synthetic.jsonl` is a small, non-sensitive regression corpus for the deterministic reference parser and direct-quotation aligner. Run it with:

```powershell
npm run ai:eval
```

Each JSONL record is either:

- `reference`: transcript plus an expected canonical reference or `null` for a hard negative.
- `quote`: transcript, candidate verse texts, and the expected winning canonical reference or `null`.

The CLI reports precision, recall, F1, exact-result accuracy, and local detector p95 latency. It exits unsuccessfully below the checked-in thresholds (reference precision/recall `0.99/0.90`; quotation precision/recall `0.90/0.80`), making it suitable for CI. This measures deterministic detection only—not Deepgram word-error rate or network latency.

## Private sermon corpus

Do not commit sermon audio, raw transcripts, speaker names, or congregation data. Place consented and de-identified local material under `evaluation/ai-scripture/private/`, which is gitignored. Track consent, permitted uses, retention, and deletion outside this repository. Aggregate measurements may be copied into an approved report only after privacy review.
