# AI Scripture Assistant

## Product boundary

The assistant listens to an English sermon and proposes Scripture for an operator to review. It is assistive, not autonomous:

- It may create suggestion cards and automatically stage a verse when its displayed confidence is at least 90%; lower-confidence suggestions remain manual.
- It must never commit staged content, clear live output, or otherwise change the program feed.
- Normal Scripture search and projection must remain usable when audio, the network, or the transcription provider fails.
- An LLM must never invent a Bible reference. Any future LLM use is limited to reranking candidates retrieved from installed Bible text.

## Implemented beta slice

1. A provider-neutral frontend session boundary with Deepgram as the first streaming ASR adapter.
2. A dedicated consumer of the existing shared audio feed, preventing transcription, recording, and streaming from opening the DirectShow device independently.
3. Live interim/final transcript diagnostics.
4. Deterministic parsing for numeric and spoken references, including numbered books and spoken numbers through the Bible's chapter/verse range.
5. Lexical direct-quotation alignment. Candidate retrieval searches every installed English translation; the winning canonical reference is displayed in the operator-selected translation.
6. A 20-second rolling context, duplicate suppression, confidence labels, and automatic Stage-only handling at 90% confidence or above.
7. Bring-your-own Deepgram credentials encrypted at rest with current-user Windows DPAPI and excluded from Wordlyte backups.
8. Nova-3 Bible-name keyterm prompting, focused on uncommon and commonly misheard book names while avoiding broad words such as “Mark” and “Job.”
9. A CI-gated synthetic evaluation corpus and `npm run ai:eval` runner for precision, recall, F1, exact-result accuracy, and local detector p95 latency.

Paraphrase retrieval is deliberately excluded. The existing `search_semantic_query` command is lexical FTS/LIKE search, not vector retrieval.

## Runtime flow

```text
DirectShow input
  -> shared AudioFeed (single capture, AAC fan-out)
  -> private AI relay
  -> ffmpeg mono PCM 16 kHz decoder
  -> Deepgram streaming WebSocket
  -> final/interim transcript events
  -> deterministic reference parser OR lexical quotation matcher
  -> operator suggestion card
  -> Stage (automatic at >=90% confidence; otherwise operator action)
  -> Go Live (separate operator action)
```

The Rust backend owns credentials, audio transport, transcription, and detection. A global React provider owns session status and recent transcript/suggestions so listening continues while the operator changes workspaces.

## Safety and privacy

- The workspace states when audio is being sent to Deepgram and provides an explicit Stop control.
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
- Record reference precision/recall, quotation precision/recall, provider word error rate, and end-to-end latency.
- Add fixtures for ASR variants such as “First John,” “one John,” ranges, abbreviations, and cross-segment references.

### Beta hardening

- Validate Deepgram authentication, reconnect/error behavior, long-session billing, and audio quality on representative church mixers.
- Add a transcript export only if an explicit retention/consent policy is approved.
- Add session usage and provider-cost diagnostics without logging credentials or sermon text.
- Decide whether AI should be license-gated after beta; safety controls must remain backend-enforced regardless of tier.

### Later detection phases

- Improve quotation candidate retrieval and calibrate thresholds against the corpus.
- Build a real offline verse embedding index and approximate-nearest-neighbor runtime for paraphrase candidates.
- Require operator selection for every paraphrase result and label paraphrase confidence separately.
- Optionally use an LLM only to rerank retrieved verses, never to generate references or verse text.

### Commercial authentication

- Add a Wordlyte broker that authenticates the installation and issues short-lived provider sessions.
- Enforce quotas, revocation, abuse controls, provider failover, and clear retention terms.
- Keep BYO credentials available for development and controlled beta testing only.
