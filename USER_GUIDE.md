# Wordlyte Operator Guide

## Before the service

1. Open **Settings → Monitors** and assign the projector and confidence display.
2. Show the test pattern and confirm that each display is framed correctly.
3. Build the running order in **Service Plan**. Leave **Keep after playing** on when you may need to revisit items.
4. Stage and preview one Scripture, song, media item, and presentation slide.
5. Check camera, recording, audio, remote control, and streaming inputs that the service will use.
6. Open **Settings → Data & Backup** and save a backup after major preparation.

Hardware-dependent output, capture, recording, and streaming should be tested on the actual presentation computer before the room is occupied.

## Safe live operation

- **Cyan / Staged** is the next item. Selecting content normally stages it first.
- **Red / On Air** is what the congregation currently sees.
- Press **Enter** or the cockpit **Go Live** button only after checking the staged preview.
- Press **Esc** to clear live output. Use **Ctrl+Shift+X** only when both live and staged content must be cleared.
- Service Plan advancement is transactional: a one-shot entry remains in the plan if Wordlyte cannot send it live.
- **Arrow Down/Up** advances through the Service Plan only after the output backend confirms the change.

### Operator workspace

- The left rail keeps preparation focused on **Scripture, Songs, Media, Presentations,** and the **Service Plan**. Design, system, recording, streaming, remote, and settings workspaces are grouped under **More**.
- **Live Tools** opens the shared Lower Third, Timers, Props, Camera, and Scenes dock. The compact dock remains available at the bottom when the full panel is closed and marks active tools.
- The right-side **Live Control** panel always shows **Preview** (staged, not live) and the canonical **Program** output seen by the audience.
- Preview and Program use full-width monitors in Live Control. Below them, **Live Tools** shows active layer status and opens the appropriate dock, while **Quick History** lets you stage a previous live item or deliberately restore it live.
- Use the large **Go Live** control only after checking Preview. Blackout and Clear All remain separate emergency actions.
- The collapsible **Service Rundown** strip below the main workspace labels live, previewed, and next entries without occupying Live Control. Click an entry to stage it, drag its handle to reorder it, or use the deliberately separate lightning action to send it directly live. It compacts automatically while the full Live Tools panel is open.
- Drag the divider beside Live Control to resize it. Navigation, Live Tools height, and Live Control width are remembered on this computer.

## Presentation workspace

Open **Presentations** to create and manage editable decks. The workspace remembers your grid/list view, sort order, and favorites on this computer.

- Use **New presentation**, **AI draft**, **Prayer DOCX**, or **PowerPoint** to choose the right starting workflow.
- Select a deck to open its slide detail panel. Recent decks show their real first-slide artwork in the library.
- Select a slide to stage it. **Live** is a separate, explicitly labeled action; creating, importing, duplicating, or editing a deck never changes output.
- Use **Duplicate** to create an independent editable copy. Referenced media files remain shared, while all presentation, slide, element, group, theme, and master identities are regenerated.
- Use the search, sort, favorites, and grid/list controls to keep larger libraries manageable.

### Presentation design tools

Inside the Slide Editor, the colored authoring toolbar includes these deck-level tools:

- **Layout:** applies a deterministic balanced, hero, split, or stacked arrangement to the current slide. Content and element identities are preserved, and the change is one Undo step.
- **Brand:** saves a local church brand kit and applies its font, text color, accent, and background across the editable deck. Image and video backgrounds remain unchanged.
- **Outline:** groups slides into named message sections and provides a compact narrative view.
- **Check:** opens live preflight and overlays title/action-safe guides plus warnings for blank slides, missing media, unsafe geometry, small text, and dense text. Preflight never changes content.
- **Rehearse:** opens a private full-screen rehearsal with elapsed time, speaker notes, the next slide, and keyboard navigation. It never stages or broadcasts.
- **Slide transition:** use the Slide inspector to choose Cut, Fade, Dissolve, Slide, Push, or Zoom and set its duration. Per-slide transitions override the global output transition for that slide.

## PowerPoint import

In **Presentations**, choose **Import PPTX**. Wordlyte asks desktop Microsoft PowerPoint to render every slide to a 1920×1080 PNG, then creates a normal Wordlyte deck from those images.

- Rendering preserves PowerPoint layout, fonts, and effects more faithfully than editable conversion.
- Desktop Microsoft PowerPoint is required during import on Windows.
- Imported slides are images: text and individual elements are not editable in Wordlyte.
- Animations, transitions, embedded video, presenter notes, and macros do not remain interactive.
- PowerPoint is not required for playback after a successful import.

## AI presentation creation (beta)

Open **Settings → AI Creation** and save a church-owned OpenAI API key. In **Presentations**, select **Create with AI**, enter a topic and optional notes, choose the audience, slide count, and installed Bible version, then select **Generate outline**.

- Wordlyte shows the generated outline and Scripture-verification warnings before creating anything.
- Select **Create editable deck** to save a normal Studio presentation and open it in the Slide Editor. Generated text, layouts, key-point accents, and speaker notes remain editable.
- Bible verse text is never accepted from the AI provider. Wordlyte validates generated references and loads exact text from the selected installed Bible version.
- Topic and notes are sent to OpenAI only when generation starts. The API key is protected with Windows DPAPI and excluded from backups.
- Generation never stages a slide or changes live output. Review the finished deck and continue using the normal **Stage → Go Live** workflow.

### AI slide editing

Open an editable presentation in the Slide Editor and use the **AI** menu in the canvas toolbar:

- Select an unlocked text element to **Shorten**, **Rewrite**, **Convert to bullets**, or **Highlight key phrases**.
- Use **Generate speaker notes** or **Regenerate this slide** with or without a selected text element.
- Wordlyte shows the current content and AI suggestion side by side. Nothing changes until you select **Apply change**.
- An applied suggestion is one normal Undo step. Existing slide geometry, media, background, and theme are preserved when regenerating a slide.
- Regenerated Scripture is inserted only after its reference is verified against the selected installed Bible. AI editing never stages a slide or changes live output.

### Daily prayer DOCX import

In **Presentations**, select **Prayer DOCX** and choose a weekly Covenant Hour of Prayer `.docx` file. Wordlyte detects the weekday sections and intercessions, verifies each reference against the currently selected installed Bible version, and previews the result before saving.

- Choose **Create daily decks** to create one editable presentation per day.
- Each daily deck contains a title slide, followed by separate prayer and verified-Scripture slides for every intercession.
- Verse text is loaded from Wordlyte's installed Bible rather than copied from the Word document.
- Missing or invalid references are shown as review warnings. Import never stages content or changes live output.

## AI Scripture Assistant (beta)

Open **Settings → AI Scripture** to choose Deepgram or AssemblyAI and save the church-owned API key for that provider. Then return to **Scripture**, expand **Live Scripture Assistant**, choose the mixer or microphone input and translation, and select **Start listening** only after obtaining any consent required by your church and local law.

- Audio and transcript data are sent to the selected provider while listening. Stop listening when transcription is no longer needed. Wordlyte does not retain the audio. Final transcript segments and Scripture suggestions are saved locally in **Saved sessions**; they are included in Wordlyte backups and can be reviewed, exported as Markdown/plain text/JSON, or deleted by the operator. Provider keys are stored separately with Windows DPAPI and are never included in backups.
- The API key is encrypted with Windows DPAPI for the current Windows user. It is excluded from Wordlyte backups.
- The assistant detects spoken references and close direct quotations in English. Select **Prepare** under Local paraphrase matching to download the small local model once and load Wordlyte's compact index of installed English Bible text. Preparation runs in the background and is not required for normal projection, references, or quotations.
- After a reference or confirmed direct quotation, say **“next verse”**, **“following verse”**, **“previous verse”**, or **“go back one verse”** to create a manual voice-command suggestion for the adjacent verse.
- Change translation without stopping transcription by saying **“give me NLT”**, **“show me Amplified”**, **“switch to King James”**, or the name/code of another enabled installed translation. Combined commands such as **“next verse in NLT”** and references such as **“John 3:16 in King James”** are supported. Wordlyte acknowledges the switch and updates the Scripture workspace translation. When a verse is already under discussion, it also shows that verse in the new translation as a manual suggestion card. It never alters the live feed.
- A paraphrased thought may produce up to three amber **Possible theme** cards. Adjacent high-scoring verses are shown as a passage signal, but **Stage** always uses the strongest verse printed on that card. Every possible theme remains manual-only.
- When two strong themes are too close to select safely, Wordlyte may show both as manual alternatives instead of declaring one winner. The diagnostics panel labels this result **Ambiguous**.
- Use **Show diagnostics** to inspect the latest local similarity, distinct-passage margin, candidate references, and latency. Diagnostics do not display or persist sermon text. Preparation can be cancelled and retried; **Remove model** deletes downloaded AI files without affecting normal Bible projection or the bundled meaning index.
- Paraphrase cards are labeled **Possible theme** and remain manual-only while confidence is being qualified. Treat every result as a suggestion and verify its reference and text.
- Explicit-reference and confirmed direct-quotation suggestions at **90% confidence or above are staged automatically** in the normal staged preview. Lower-confidence suggestions, possible themes, and next/previous voice commands require **Stage** by default.
- To allow automatic live output, open **Settings → AI Scripture → AI Scripture Auto Live**, enable the master switch, then choose the allowed categories: direct references, direct quotations, paraphrase themes, and/or voice commands. All switches default to off. References and quotes still require a final 90%+ match; only the top stable local paraphrase can auto-live. The setting uses the normal Send Live path and changes congregation output immediately, so enable only with an operator monitoring the service.
- **Performance measurements:** Open **Settings → AI Scripture → AI Scripture Performance** during a listening session. It shows median and p95 timings for **ASR update → verified Scripture**, verified-to-operator, verified-to-stage, verified-to-live-commit, and Auto Live request acknowledgement; it also breaks ASR-to-verification timing down by references, quotes, themes, and commands. Service restarts and repeated Operator mode calls accumulate in the same measurement set, so run 30–100 calls before copying a qualification report; press **Reset** to start over, or switch provider/mode for a separate set. Aggregate performance data and separately reviewable saved-session records are retained locally; audio and credentials are not retained. ASR update → verified begins only after the provider sends an interim/final update, so it does not claim to measure speech or provider-recognition time. “Live committed” ends when Wordlyte receives success from its atomic Send Live command; it does not claim to measure output-screen rendering or downstream streaming/CDN delay.
- **Presentation reuse:** In **Presentation → Create with AI**, choose a saved AI Scripture session above **Notes or manuscript**, then select **Use latest snapshot**. Sessions still listening are marked **In progress** and refresh while the creation window is open. Wordlyte copies the finalized transcript available at that moment into the editable source field so you can review or trim it before requesting key points and slides. New speech never silently changes an active generation request; select **Use latest snapshot** again to include it. Nothing is staged or sent live by this action.
- **Listening modes:** The Live Scripture Assistant offers **Service mode** for continuous sermon listening and **Operator mode** for an on-demand voice lookup. Operator mode starts when you press **Start command** and stops after one verified local reference, direct quote, or voice command; raw transcript and possible paraphrase themes do not stop it. After establishing a Scripture reference, you can say **next verse**, **previous verse**, or **go to verse 12** to navigate within its chapter. The selected mode is remembered on this device. Auto Live remains separately controlled in Settings.
- **Audio input:** The microphone/mixer selected in the Live Scripture Assistant is remembered and shared with the Recording and Streaming input pickers. If the device is unplugged or renamed, Wordlyte safely clears the saved choice and asks for a new input.
- If the network or provider fails, normal Scripture search and all projection controls remain available.

## Backup and restore

Open **Settings → Data & Backup**.

**Create Backup** stores services, schedules, songs, presentations, scenes, lower thirds, settings, media, fonts, thumbnails, and output configuration in a `.wordlyte-backup` archive.

**Restore** validates the archive and its SQLite database before scheduling any replacement. Wordlyte then restarts, preserves the current installation in a timestamped `pre-restore-*` directory, and applies the replacement before opening its database. A failed filesystem operation rolls back to the original installation.

For security and portability, backups exclude machine-bound licenses, pairing credentials, TLS keys, logs, recordings, and downloadable Bible assets. Activate the destination computer and download Bible assets separately.

Keep at least one backup outside the presentation computer.

## First-run tour

The first successful launch shows a short tour covering displays, staged/live operation, and backup. Completing or skipping it stores a local completion marker. It does not alter church content.

## NDI status

NDI remains disabled in normal builds. The integration has explicit SDK/runtime build gates and diagnostics, but it must not be treated as production-ready until the vendor SDK sender is compiled and validated against a real receiver. See `TODO.md` for the remaining developer-only qualification work.

## Recovery

- After an unexpected shutdown, accept the recovery prompt to restore the last service plan snapshot.
- If a restore was applied, the prior data remains in the app data directory under `pre-restore-*`.
- Use **Diagnostics** and the log viewer when a backend or hardware action fails.
- Never delete an existing app-data directory while investigating a problem; copy it first.

See `SHORTCUTS.md` for the complete operator shortcut list.
