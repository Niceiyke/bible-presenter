# Wordlyte vs. Pewbeam

**Research date:** November 7, 2026  
**Product under review:** Wordlyte (`bible-presenter` repository)  
**Competitor:** Pewbeam

## Executive summary

Wordlyte is ahead in product breadth, while Pewbeam is ahead in product maturity,
turnkey onboarding, and market traction.

Current estimate:

- **Core AI Scripture parity:** approximately 80–90% architecturally
- **Overall product-surface parity:** approximately 65–70%
- **Production/readiness parity:** approximately 45–55%
- **Overall competitive position:** Wordlyte is suitable for controlled beta
  competition, but Pewbeam is currently the safer choice for a church seeking a
  proven Sunday-morning product.

These are directional product estimates, not benchmark measurements.

## Wordlyte's advantages

### Broader church-production platform

The current repository includes:

- Scripture, songs, hymns, media, and cameras
- Service plans and scheduling
- Presentations and a native slide editor
- Lower thirds, timers, props, and scenes
- Local recording
- Native RTMP streaming
- Phone/tablet remote control and phone-camera contribution
- Multi-output architecture
- AI presentation generation and contextual slide editing
- PowerPoint and Prayer DOCX import

Pewbeam is expanding into slides and broader service automation, but its core
strength remains AI Scripture presentation.

### More conservative AI safety model

Wordlyte's AI Scripture Assistant provides:

- Deterministic Scripture-reference parsing
- Spoken verse ranges
- Direct-quotation matching
- Local semantic Scripture retrieval
- Confidence, margin, and stability thresholds
- Duplicate suppression and rolling context
- Deepgram and AssemblyAI provider support
- Service and operator listening modes
- Auto Live disabled by default
- Per-category Auto Live approval
- No LLM-generated Bible references or Bible text

This supports a strong positioning: **AI copilot with production safety**, rather
than blind automation.

### Stronger remote-control security model

Wordlyte's remote system includes:

- HTTPS/TLS on the local network
- Pairing codes and persistent device tokens
- Roles and granular permissions
- Exclusive controller leases
- Device revocation
- Phone-camera relaying
- Backend permission enforcement

Pewbeam exposes local HTTP and OSC controls. Its documentation notes that some
navigation commands are still being wired through.

### Direct streaming and recording

Wordlyte has a native RTMP Streaming Hub and local recording using shared capture
and audio pipelines. This gives Wordlyte a stronger direct workflow for churches
that need to publish to streaming platforms without relying on another program.

## Pewbeam's advantages

### Turnkey transcription

Wordlyte currently requires the church or beta operator to configure a Deepgram or
AssemblyAI credential. Pewbeam provides the transcription experience directly.
This is likely Wordlyte's largest immediate onboarding weakness.

### Offline speech recognition

Pewbeam supports local MLX-Whisper transcription on Apple Silicon Macs. Wordlyte
has local semantic Scripture retrieval, but its speech-to-text path still depends
on a provider. Wordlyte's secure AI credential storage is currently documented as
Windows-specific.

### NDI and HDMI maturity

Pewbeam currently advertises:

- NDI and HDMI output
- Alpha transparency for overlays
- 720p, 1080p, and 4K output
- Multiple output channels with per-output themes
- OBS, vMix, ProPresenter, EasyWorship, and Resolume interoperability

Wordlyte's NDI implementation is not production-ready yet. The repository's
`TODO.md` and `src-tauri/src/commands/ndi.rs` identify it as gated scaffolding,
and the current Streaming Hub UI is RTMP-focused.

### AI content workflow

Pewbeam currently offers or documents:

- AI slide generation and automatic display
- Sermon notes
- Transcript history
- PDF, DOCX, and Markdown exports
- Greek/Hebrew word study
- Follow-the-service slide suggestions
- Voice slide controls
- Live sermon excerpts and self-building lists

Wordlyte has AI deck generation, slide editing assistance, and structured content
creation, but does not yet match Pewbeam's transcript-to-notes and live-excerpt
workflow.

### Polish, trust, and distribution

Pewbeam has a public free tier, current public pricing, frequent releases,
support documentation, customer logos, and reported use across 30+ countries.
Wordlyte currently presents as a powerful beta platform rather than a fully
turnkey church product.

## Capability comparison

| Area | Current leader | Notes |
| --- | --- | --- |
| AI Scripture architecture | Wordlyte, slight edge | More explicit safety, provider choice, local retrieval, and diagnostics |
| Real-world AI reliability evidence | Pewbeam | More public product usage and service feedback |
| Full church-production workflow | Wordlyte | More content, service, camera, scene, recording, and streaming primitives |
| NDI/HDMI integration | Pewbeam | Wordlyte NDI is still gated/scaffolded |
| RTMP and recording | Wordlyte | Native RTMP hub and shared capture/audio pipeline |
| Remote security and permissions | Wordlyte | Pewbeam's documented HTTP/OSC layer is less complete |
| Offline speech transcription | Pewbeam | MLX-Whisper on Apple Silicon Macs |
| Slide/content automation | Pewbeam, currently | Excerpts, sermon notes, follow-service, and automatic display |
| Onboarding and ease of use | Pewbeam | No BYO transcription credentials required |
| Market traction and trust | Pewbeam | Public plans, support, releases, and customer presence |
| Extensibility and platform potential | Wordlyte | More modular production architecture and broader roadmap |

## Recommended positioning

Wordlyte should not be positioned as “another Pewbeam.” The stronger position is:

> **The complete church production control plane—with a safe AI Scripture
> copilot.**

Pewbeam's message is effectively “run your service, not your slides.” Wordlyte
can differentiate by covering the complete service:

> **Prepare the whole service, operate every source, and let AI assist without
> taking production control away from you.**

## Priority actions

1. Remove API-key friction with Wordlyte-issued short-lived transcription
   sessions or a hosted transcription broker.
2. Finish and ship NDI. This is the most visible technical integration gap.
3. Add transcript history, sermon notes, and export workflows.
4. Add local offline speech recognition on Windows and macOS.
5. Build a consented church-service evaluation corpus and measure Scripture
   precision, recall, false positives, accent/noise performance, and end-to-end
   latency.
6. Improve first-run setup, updates, support, public pricing, and diagnostics.
7. Preserve differentiation around service plans, songs, cameras, lower thirds,
   scenes, recording, streaming, and operator-controlled AI safety.

## Sources

Official Pewbeam sources reviewed:

- [Pewbeam pricing](https://pewbeam.com/pricing)
- [Pewbeam documentation](https://pewbeam.com/docs)
- [Pewbeam changelog](https://pewbeam.com/changelog)
- [Broadcast outputs: NDI and HDMI](https://support.pewbeam.com/article/25-broadcast-outputs-ndi-hdmi)
- [Bible search and AI verse detection](https://support.pewbeam.com/article/21-bible-search-and-real-time-ai-verse-detection)
- [Plans and pricing support article](https://support.pewbeam.com/article/17-plans-and-pricing)
- [Pewbeam privacy policy](https://pewbeam.com/privacy)

Repository evidence reviewed:

- `docs/AI_SCRIPTURE_ASSISTANT.md`
- `docs/AI_PRESENTATION_ASSISTANT.md`
- `docs/PRESENTATION_SYSTEM.md`
- `CLAUDE.md`
- `TODO.md`
- `src/system/tiers.ts`
- `src-tauri/src/commands/ndi.rs`
