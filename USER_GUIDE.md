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

## PowerPoint import

In **Presentations**, choose **Import PPTX**. Wordlyte asks desktop Microsoft PowerPoint to render every slide to a 1920×1080 PNG, then creates a normal Wordlyte deck from those images.

- Rendering preserves PowerPoint layout, fonts, and effects more faithfully than editable conversion.
- Desktop Microsoft PowerPoint is required during import on Windows.
- Imported slides are images: text and individual elements are not editable in Wordlyte.
- Animations, transitions, embedded video, presenter notes, and macros do not remain interactive.
- PowerPoint is not required for playback after a successful import.

## AI Scripture Assistant (beta)

Open **AI Scripture**, enter a church-owned Deepgram API key, choose the mixer or microphone input, and choose the translation used for suggestion cards. Select **Start listening** only after obtaining any consent required by your church and local law.

- Audio and transcript data are sent to Deepgram while listening. Stop listening when transcription is no longer needed.
- The API key is encrypted with Windows DPAPI for the current Windows user. It is excluded from Wordlyte backups.
- The assistant detects spoken references and close direct quotations in English. Treat every result as a suggestion and verify its reference and text.
- Suggestions at **90% confidence or above are staged automatically** in the normal staged preview. Lower-confidence suggestions require **Stage**. Always review the staged verse: the assistant cannot send content live, and only the operator can use **Go Live**.
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
