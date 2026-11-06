# AI Scripture Assistant

## Product boundary

The assistant listens to an English sermon and proposes Scripture for an operator to review. It is assistive, not autonomous:

- It may create suggestion cards and automatically stage a verse when its displayed confidence is at least 90%; lower-confidence suggestions remain manual.
- It must never commit staged content, clear live output, or otherwise change the program feed.
- Normal Scripture search and projection must remain usable when audio, the network, or the transcription provider fails.
- An LLM must never invent a Bible reference. Any future LLM use is limited to reranking candidates retrieved from installed Bible text.

## Implemented beta slice

1. A provider-neutral frontend session boundary with Deepgram and AssemblyAI streaming ASR adapters.
2. A dedicated consumer of the existing shared audio feed, preventing transcription, recording, and streaming from opening the DirectShow device independently.
3. Live interim/final transcript diagnostics.
4. Deterministic parsing for numeric and spoken references, including numbered books, spoken numbers through the Bible's chapter/verse range, and bounded spoken verse ranges such as “First Corinthians chapter ten, verses eleven and twelve.” The first verse is eligible for automatic staging; additional range cards remain manual.
5. Lexical direct-quotation alignment. Candidate retrieval searches every installed English translation; the winning canonical reference is displayed in the operator-selected translation. Five-word exact quotations are supported but capped at 89% confidence for manual review.
6. A 20-second rolling context, duplicate suppression, confidence labels, and automatic Stage-only handling at 90% confidence or above for eligible longer quotations and explicit references.
7. Bring-your-own Deepgram or AssemblyAI credentials encrypted at rest with current-user Windows DPAPI and excluded from Wordlyte backups.
8. Nova-3 Bible-name keyterm prompting, focused on uncommon and commonly misheard book names while avoiding broad words such as “Mark” and “Job.”
9. A CI-gated synthetic evaluation corpus and `npm run ai:eval` runner for precision, recall, F1, exact-result accuracy, and local detector p95 latency.
10. A low-latency detection pipeline: finalized explicit references use an immediate deterministic fast path, while one bounded cross-translation quotation query runs in a coalescing background worker and stale quote results are discarded. Semantic context prefers the latest complete sentence, can include one preceding sentence when the latest thought is short, stops across a four-second speech gap, and is capped at 48 words.
11. AI auto-staging splits and stages a verse in one backend round trip while retaining all splits for normal next/previous navigation.
12. Optional local paraphrase retrieval uses a quantized BGE-small sentence-transformer and one int8 embedding per canonical verse. The bundled 12 MB index averages the precomputed vectors of every installed English translation; the selected translation is fetched only after a canonical match is found. Model downloads are pinned to immutable revision `ea104dacec62c0de699686887e3f920caeb4f3e3`, and every ONNX/tokenizer file is SHA-256 verified before loading.
13. Paraphrase preparation and retrieval run off the audio/WebSocket loop. Paraphrase confidence is capped at 89% and the frontend independently prevents paraphrase auto-staging until a representative sermon corpus supports calibration.
14. Exact cosine ranking blends each verse with immediate same-chapter neighbors and collapses adjacent winners into passage signals. Similarity must be `>= 0.70`. Possible themes are emitted immediately only with exceptionally strong similarity and margin; otherwise the same chapter must recur across consecutive complete thoughts. This stability gate suppresses transient one-segment embedding associations.
15. The operator can inspect local retrieval latency, thresholds, winner margin, and candidate references without exposing sermon text in diagnostics. Preparation reports verified-file progress, pre-warms inference, shows disk usage, supports cancellation/retry, and can remove downloaded model files.
16. A transient transcription-decoder EOF triggers up to two bounded audio-feed recovery attempts while the selected ASR session remains open. Decoder and shared-feed exit details are retained only in the local application log; exhausting recovery ends AI Scripture without affecting normal projection.
17. AssemblyAI Universal-3.6 Pro uses explicit low-latency turn detection (`mode=min_latency`, 300 ms minimum and 900 ms maximum turn silence). During an unusually long open turn, Wordlyte checks growing partial snapshots every six words: an explicit reference must remain unchanged across two snapshots, and interim references/strong quotations are capped at 89% for manual review. Semantic themes still require formatted final turns. On Stop, Wordlyte continues reading after `Terminate` through the provider's final `Turn` and `Termination` messages so the open sentence is not lost; its confirmed card replaces the matching interim card.

### Local paraphrase components

- `BAAI/bge-small-en-v1.5` — MIT-licensed model; the quantized ONNX export is retrieved from `Xenova/bge-small-en-v1.5` at the pinned revision documented above.
- FastEmbed — Apache-2.0 Rust embedding runtime.
- ONNX Runtime — MIT-licensed inference runtime, statically linked into the Windows build.

The model is downloaded only after the operator selects **Settings → AI Scripture → Prepare**. After a successful preparation, Wordlyte may reload the verified local model automatically when Live Scripture Assistant starts; sermon text remains local for paraphrase retrieval.

`scripts/compact-semantic-index.py` deterministically rebuilds the installer-bundled int8 index from SHA-256-pinned per-translation BGE vectors and metadata. Its corpus/model fingerprint prevents Wordlyte from loading an index that does not match the installed Bible text or query model, and the generated artifact must match its pinned SHA-256.

The older `search_semantic_query` command remains lexical FTS/LIKE search. AI Scripture paraphrases use the separate local vector path in `semantic_scripture.rs`; they run only after reference and quotation detection fail.

Run the labeled semantic probe with `cargo test semantic_scripture::tests::bundled_index_quality_probe -- --ignored --nocapture`. The current 38 fixtures (22 positive themes and 16 operational hard negatives) are a conservative regression check, not a confidence-calibration corpus. The current gate rejects all checked-in hard negatives; broader consented sermon data is still required before changing manual-only handling.

## Runtime flow

```text
DirectShow input
  -> shared AudioFeed (single capture, AAC fan-out)
  -> private AI relay
  -> ffmpeg mono PCM 16 kHz decoder
  -> selected Deepgram or AssemblyAI streaming WebSocket
  -> final/interim transcript events
  -> deterministic reference fast path OR background lexical quotation matcher
  -> if neither matches, optional local BGE query + exact cosine verse retrieval
  -> operator suggestion card
  -> Stage (automatic at >=90% confidence; otherwise operator action)
  -> Go Live (separate operator action)
```

The Rust backend owns credentials, audio transport, transcription, and detection. The Scripture workspace contains the Live Scripture Assistant panel, while a global React provider owns session status and recent transcript/suggestions so listening continues while the operator changes workspaces. Provider keys and local-model controls are in Settings → AI Scripture.

## Safety and privacy

- The Live Scripture Assistant panel states which provider is receiving audio and provides an explicit Stop control. Permanent provider keys remain encrypted with Windows DPAPI.
- Churches are responsible for obtaining consent required by their policy and local law.
- API keys are never embedded in the distributed desktop app or returned to the frontend after storage.
- The transcript and suggestions are held in memory only in this beta. They are not added to backups or service data.
- Provider errors end the AI session and surface an error status without affecting live or staged content.
- Commercial distribution should replace BYO keys with short-lived, metered Wordlyte-issued sessions; a permanent provider master key must not ship in the app.

## Acceptance targets

- At least 99% precision for explicit-reference suggestions on the agreed sermon evaluation corpus.
- Under 3 seconds p95 from final ASR segment to visible suggestion under supported network conditions.
- Zero live transitions initiated by the assistant.
- Recording, streaming, and AI transcription can share one selected audio device without capture contention.
- Loss of provider connectivity does not interrupt normal projection.

## Qualification backlog

### Corpus and measurement

- Expand beyond the checked-in synthetic regression corpus with a consented, de-identified sermon corpus containing accents, room acoustics, reference styles, quotations, and hard negatives.
- Use `evaluation/ai-scripture/paraphrase.jsonl` as the initial labeled semantic set, but do not treat it as sufficient for confidence calibration or automatic staging.
- Record reference precision/recall, quotation precision/recall, provider word error rate, and end-to-end latency.
- Add fixtures for ASR variants such as “First John,” “one John,” ranges, abbreviations, and cross-segment references.

### Beta hardening

- Validate Deepgram and AssemblyAI authentication, reconnect/error behavior, long-session billing, and audio quality on representative church mixers.
- Add a transcript export only if an explicit retention/consent policy is approved.
- Add session usage and provider-cost diagnostics without logging credentials or sermon text.
- Decide whether AI should be license-gated after beta; safety controls must remain backend-enforced regardless of tier.

### Later detection phases

- Improve quotation candidate retrieval and calibrate thresholds against the corpus.
- Expand semantic fixtures and tune the conservative similarity/margin gates without weakening manual-only handling.
- Consider approximate-nearest-neighbor retrieval only if exact cosine search misses the latency target on supported hardware.
- Optionally use an LLM only to rerank retrieved verses, never to generate references or verse text.

### Commercial authentication

- Add a Wordlyte broker that authenticates the installation and issues short-lived provider sessions.
- Enforce quotas, revocation, abuse controls, provider failover, and clear retention terms.
- Keep BYO credentials available for development and controlled beta testing only.
