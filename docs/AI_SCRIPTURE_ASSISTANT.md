# AI Scripture Assistant

## Product boundary

The assistant listens to an English sermon and proposes Scripture for an operator to review. It is assistive by default:

- It may create suggestion cards and automatically stage a verse when its displayed confidence is at least 90%; lower-confidence suggestions remain manual.
- It must never clear live output. It may use the normal atomic Send Live path only when the operator has explicitly enabled Auto Live and selected the suggestion category.
- Normal Scripture search and projection must remain usable when audio, the network, or the transcription provider fails.
- An LLM must never invent a Bible reference. Any future LLM use is limited to reranking candidates retrieved from installed Bible text.

## Implemented beta slice

1. A provider-neutral streaming boundary: Deepgram and AssemblyAI adapters live in `src-tauri/src/commands/ai_scripture/providers.rs` and normalize service-specific messages, errors, and shutdown into shared transcript events. The desktop connects to the Wordlyte AI Gateway with a short-lived AI token; provider credentials remain server-side. Audio transport and Scripture detection do not branch on provider. The operator can select either managed provider for the next session; switching an active WebSocket session requires stopping and starting again.
2. Two operator-selected listening modes: Service mode listens continuously until stopped; Operator mode is an on-demand one-result session that stops after a verified reference, direct quote, or deterministic voice command. It does not stop for raw transcript or paraphrase candidates.
2. A dedicated consumer of the existing shared audio feed, preventing transcription, recording, and streaming from opening the DirectShow device independently.
3. Live interim/final transcript diagnostics.
4. Deterministic parsing for numeric and spoken references, including numbered books, spoken numbers through the Bible's chapter/verse range, and bounded spoken verse ranges. One spoken citation produces one passage card with a start/end range; only that first card is eligible for automatic staging, so a range cannot trigger multiple Stage/Live actions.
5. Lexical direct-quotation alignment over the selected output translation. An in-memory rare-content-word index narrows each 24-word window to a small candidate pool; common sermon phrases no longer trigger broad full-text OR scans. Quote cards carry the matching phrase, translation, rare-term count, and an anchored/loose support label. Five-word exact quotations remain capped at 89% confidence for manual review.
6. A 20-second rolling context, duplicate suppression, confidence labels, automatic staging at 90% confidence or above for eligible longer quotations and explicit references, and an explicit off-by-default Auto Live control.
7. Subscription-managed Wordlyte AI access. The organization's AI Add-on and Unit balance authorize a short-lived device token; no provider key is stored on the computer.
8. Nova-3 Bible-name keyterm prompting, focused on uncommon and commonly misheard book names while avoiding broad words such as “Mark” and “Job.”
9. A CI-gated synthetic evaluation corpus and `npm run ai:eval` runner for precision, recall, F1, exact-result accuracy, and local detector p95 latency.
10. A low-latency detection pipeline: finalized explicit references use an immediate deterministic fast path, while quotation retrieval runs only on finalized turns through a rare-word index and a bounded cross-turn cache. Interim text is used for deterministic reference previews only; it never runs quotation FTS. Loose quote matches are capped below the automatic Stage/Live boundary unless the same turn supplies a matching citation or an attribution cue. Semantic context prefers the latest complete sentence, can include one preceding sentence when the latest thought is short, stops across a four-second speech gap, and is capped at 48 words.
11. AI auto-staging splits and stages a verse in one backend round trip while retaining all splits for normal next/previous navigation.
12. Optional local paraphrase retrieval uses a quantized bge-base-en-v1.5 sentence-transformer with one int8 embedding per canonical verse and passage window, built per installed English translation (NKJV, ASV, WEB, NIV, AMP) so the spoken paraphrase and indexed text share a register; KJV reuses the NKJV index. Each index is roughly 36 MB. Preparation prefers a fingerprint-verified prebuilt index bundle and falls back to building an index locally from the installed Bible text; unsupported translations skip paraphrase matching without affecting references or quotations. Model downloads are pinned to immutable revisions (`4d6cd88e18e51a5e020c2c305726d76ada9c03cf` for the embedder, `a09144355adeed5f58c8ed011d209bf8ee5a1fec` for the reranker), and every ONNX/tokenizer file is SHA-256 verified before loading.
13. Paraphrase preparation and retrieval run off the audio/WebSocket loop. Paraphrase confidence is capped at 89% and the frontend independently prevents paraphrase auto-staging until a representative sermon corpus supports calibration.
14. Retrieval is hybrid: exact cosine ranking (each verse blended with immediate same-chapter neighbors) supplies the top 24 passages, and a lexical FTS pass adds up to 12 verses the dense retriever never surfaces. A pinned `ms-marco-MiniLM-L-6-v2` cross-encoder then scores every candidate pair, and the final order blends normalized dense score (weight 0.25) with normalized rerank logit. A suggestion is accepted when the winning logit maps to `>= 0.25` probability; adjacent winners collapse into passage signals. Calibrated on 71 positive themes and 29 operational hard negatives: hybrid recall reaches 66/71, raw top-1 is 51/71 (dense-only 43/71), top-3 is 60/71, and no hard negative is accepted. Possible themes are emitted immediately only with exceptionally strong similarity and margin; otherwise the same chapter must recur across consecutive complete thoughts. This stability gate suppresses transient one-segment associations.
15. The operator can inspect local retrieval latency, thresholds, winner margin, and candidate references without exposing sermon text in diagnostics. Preparation reports verified-file progress, pre-warms inference, shows disk usage, supports cancellation/retry, and can remove downloaded model files.
16. A transient transcription-decoder EOF triggers up to two bounded audio-feed recovery attempts while the selected ASR session remains open. Decoder and shared-feed exit details are retained only in the local application log; exhausting recovery ends AI Scripture without affecting normal projection.
17. AssemblyAI Universal-3.6 Pro uses explicit low-latency turn detection (`mode=min_latency`, 300 ms minimum and 900 ms maximum turn silence). During an unusually long open turn, Wordlyte checks growing partial snapshots for deterministic references without waiting for a formatted final turn. Deepgram revisions use the same interim reference path. Quotation retrieval still waits for a finalized turn so the index sees stable text. Semantic themes require formatted final turns. On Stop, Wordlyte continues reading after `Terminate` through the provider's final `Turn` and `Termination` messages so the open sentence is not lost. The short-lived AI access token is cached in memory and refreshed while the session is healthy; if the license service is briefly unreachable, a still-valid token is reused. Provider reconnects use jittered exponential backoff over several minutes instead of exhausting attempts in under a minute.
18. Deterministic final-turn voice commands maintain a canonical last-detected-verse cursor. “Next verse,” “following verse,” “previous verse,” and “go back one verse” retrieve adjacent local Bible rows. Command cards are manual unless the operator enables Auto Live and selects voice commands. When listening starts after a verse was already projected, navigation falls back to the live verse (then the staged verse) as its cursor.
19. Translation commands resolve only against enabled installed versions. Common spoken aliases include King James/KJV, New King James/NKJV, New Living/NLT, Amplified/AMP, NIV, ESV, NASB, RSV/NRSV, CSB/HCSB, Message, TPT, GNT, and CEV. Commands can stand alone (“give me NLT”), modify navigation (“next verse in NLT”), or accompany an explicit reference (“John 3:16 in King James”). Incidental translation names without command/reference context are ignored. A standalone switch re-renders the verse currently under discussion in the new translation and returns before quotation/semantic retrieval, so operational speech is not treated as sermon content.
20. The interim reference detector and the final quotation detector share one normalized token pass. Contextual citations remember the most recently spoken book, so "in Isaiah" followed by "chapter seven and verse fourteen" resolves to Isaiah 7:14 rather than the previously projected book. If ASR splits the citation after the word "chapter", the next segment's leading number is retained as the pending chapter ("Isaiah chapter" then "seven and verse fourteen"). A quotation anywhere inside a spoken range is anchored to that range (for example Hebrews 12:28–29), and the operator sees one canonical verse card when both direct detectors agree. A spoken citation that disagrees with the lexically matched verse is surfaced as a citation-conflict warning and the quote card remains loose/manual.

### Local paraphrase components

- `BAAI/bge-base-en-v1.5` — MIT-licensed model; the quantized ONNX export is retrieved from `Xenova/bge-base-en-v1.5` at the pinned revision documented above.
- `cross-encoder/ms-marco-MiniLM-L-6-v2` — Apache-2.0 reranker; the quantized ONNX export is retrieved from `Xenova/ms-marco-MiniLM-L-6-v2` at the pinned revision documented above (about 22 MB).
- FastEmbed — Apache-2.0 Rust embedding runtime.
- ONNX Runtime — MIT-licensed inference runtime, statically linked into the Windows build.

The model is downloaded only after the operator selects **Settings → AI Scripture → Prepare**. After a successful preparation, Wordlyte may reload the verified local model automatically when Live Scripture Assistant starts; sermon text remains local for paraphrase retrieval. The prepared marker records both model revisions, so an app update that changes either pinned model intentionally requires the operator to run **Prepare** again (~145 MB).

`tools/semantic-index-builder/build_prebuilt_indexes.py` (see its README) rebuilds the published per-translation int8 bundle from the pinned model using the same corpus and document pipeline the app uses, including the passage windows and SHA-256 fingerprint. Index files carry a corpus/model fingerprint, so Wordlyte refuses an index that does not match the installed Bible text or query model, and preparation installs each verified index atomically.

The older `search_semantic_query` command remains lexical FTS/LIKE search. AI Scripture paraphrases use the separate local vector path in `semantic_scripture.rs`; they run only after reference and quotation detection fail.

Provision the probe fixture once per model or index change with `WORDLYTE_TEST_BGE_MODEL=%TEMP%\opencode\bge-base-pin cargo test semantic_scripture::tests::builds_probe_index_fixture -- --ignored --nocapture` (about 100 minutes on CPU), then run `cargo test semantic_scripture::tests::bundled_index_quality_probe -- --ignored --nocapture` with the same environment variable. That probe checks dense index health only.

For the shipped hybrid path, run `cargo test semantic_scripture::tests::evaluates_reranker_candidates -- --ignored --nocapture` with the same embedder fixture plus `WORDLYTE_TEST_RERANKER_MODEL=%TEMP%\opencode\reranker-pin` (flat pinned reranker files) and `WORDLYTE_TEST_BIBLE_DB` pointing at an installed database. It mirrors production ranking, blending, and gating, and asserts coverage, top-1, and zero hard-negative accepts.

The current 100 fixtures (71 positive themes and 29 operational hard negatives) are a conservative regression check, not a confidence-calibration corpus. With the pinned embedder, reranker, and WEB index: hybrid coverage is 66/71, raw top-1 is 51/71 (dense-only 43/71), top-3 is 60/71, and no hard negative is accepted. The five positives that are never retrieved at all — `word-guides`, `image-of-god`, `golden-rule`, `good-neighbor`, `sow-reap` — are recall gaps to attack with ASR-aware normalization and rare-word expansion, not ranking bugs. Broader consented sermon data is still required before changing manual-only handling.

## Runtime flow

```text
DirectShow input
  -> shared AudioFeed (single capture, AAC fan-out)
  -> private AI relay
  -> ffmpeg mono PCM 16 kHz decoder
  -> Wordlyte AI Gateway WebSocket -> managed Deepgram or AssemblyAI
  -> final/interim transcript events
  -> deterministic voice command / reference fast path OR background lexical quotation matcher
  -> if neither matches, optional local BGE query + exact cosine verse retrieval
  -> operator suggestion card
  -> Stage (automatic at >=90% confidence; otherwise operator action)
     OR atomic Send Live (only after explicit Auto Live category opt-in)
```

The Rust backend owns audio transport and connects to the AI Gateway; provider credentials are held only by the Gateway. The Scripture workspace contains the Live Scripture Assistant panel, while a global React provider owns session status and recent transcript/suggestions so listening continues while the operator changes workspaces. Managed AI Unit status, provider selection, and local-model controls are in Settings → AI Scripture.

## Safety and privacy

- The Live Scripture Assistant panel states which provider is receiving audio and provides an explicit Stop control. Provider credentials remain in the AI Gateway; the desktop holds only a short-lived AI token.
- Churches are responsible for obtaining consent required by their policy and local law.
- Provider API keys are never embedded in the distributed desktop app or returned to the frontend. Each listening session is authorized online and billed in AI Units.
- Finalized transcript text and Scripture suggestions can be synced to the church Dashboard only when the operator explicitly enables Dashboard transcript sync. Microphone audio is never uploaded or retained. The local session remains available if sync is disabled or fails.
- Settings → AI Scripture includes a local session Performance panel. It records only counters and timing samples (not audio, transcript text, Bible text, references, or credentials): ASR final/interim activity, suggestion source counts, automatic/manual stage/live outcomes, failures, and median/p95 ASR-update-to-verified-Scripture, verified-to-operator/stage/live timing. ASR verification samples are broken down by references, quotes, themes, and commands. “ASR update → verified Scripture” starts after a provider interim/final update reaches Wordlyte and must not be presented as speech or provider-recognition latency. “Live committed” ends at acknowledgement of Wordlyte’s atomic Send Live command; it must not be presented as a measure of display render time or downstream encoder/CDN latency.
- Provider errors end the AI session and surface an error status without affecting live or staged content.
- Auto Live is disabled by default. It requires a separate master confirmation and per-category choice for references, quotations, paraphrases, and voice-command cards. When disabled, voice navigation and translation changes never auto-stage and never mutate live output.
- With Auto Live enabled, final references and quotations still require 90% confidence; a quotation additionally requires anchored support from a matching spoken citation or attribution cue. Loose lexical matches are never Stage/Live eligible. Paraphrase output is limited to the stable rank-one candidate; voice-command cards are locally retrieved Bible rows. Each permitted card uses the normal atomic Send Live path. Disabling the master switch immediately restores Stage-only behavior.
- Commercial distribution should replace BYO keys with short-lived, metered Wordlyte-issued sessions; a permanent provider master key must not ship in the app.

## Acceptance targets

- At least 99% precision for explicit-reference suggestions on the agreed sermon evaluation corpus.
- Under 3 seconds p95 from final ASR segment to visible suggestion under supported network conditions.
- Zero assistant-initiated live transitions unless the operator has explicitly enabled Auto Live and selected that suggestion category.
- Recording, streaming, and AI transcription can share one selected audio device without capture contention.
- Loss of provider connectivity does not interrupt normal projection.

## Qualification backlog

### Corpus and measurement

- Expand beyond the checked-in synthetic regression corpus with a consented, de-identified sermon corpus containing accents, room acoustics, reference styles, quotations, and hard negatives.
- Use `evaluation/ai-scripture/paraphrase.jsonl` as the initial labeled semantic set, but do not treat it as sufficient for confidence calibration or automatic staging.
- Record reference precision/recall, quotation precision/recall, provider word error rate, and end-to-end latency.
- Add fixtures for ASR variants such as “First John,” “one John,” ranges, abbreviations, and cross-segment references.

### Beta hardening

- Validate managed Gateway authentication, reconnect/token-refresh behavior, fractional Unit settlement, zero-balance cutoff, and audio quality on representative church mixers.
- Add a transcript export only if an explicit retention/consent policy is approved.
- Add session usage and provider-cost diagnostics without logging credentials or sermon text.
- Exercise a supervised zero-balance soak on a one-Unit organization. The gateway closes the provider stream with code `4402` when the next minute cannot be reserved.
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
