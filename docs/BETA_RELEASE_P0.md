# Beta release P0 gate

Wordlyte beta is released only after the automated checks pass and a supervised
service rehearsal is completed. The gate favors predictable operator recovery
over feature breadth.

## Automated gate

From the repository root:

```text
npm run check:p0
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

`npm run check:p0` runs the tracked-file credential scan, all frontend tests,
and the production build. The Rust suite covers Scripture detection, output
transactions, audio relaying, persistence, backup validation, and recovery
paths.

## Desktop readiness gate

Open **Diagnostics → P0 release gate** on the target service computer and run
the gate immediately before rehearsal. Red checks must be fixed. Amber checks
must be explicitly accepted by the operator.

The gate checks:

- persistent app storage and startup issues;
- Bible versions available;
- DirectShow audio input enumeration;
- at least one securely stored AI transcription provider credential;
- Preview/Program output configuration and runtime errors;
- ffmpeg and native output capture prerequisites;
- recording transport errors;
- RTMP destination errors.

The report can be copied into a support ticket. It does not claim that a
physical projector, microphone, or external streaming ingest has been tested.

## Supervised rehearsal

1. Open the output window and confirm the physical display.
2. Stage a Scripture slide and verify Preview is not live.
3. Press **Go Live**, then verify Program and the physical output.
4. Clear the staged item, clear Program, and test **Undo** where applicable.
5. Toggle **Blackout**, confirm the audience output is black, then restore it.
6. Start AI Scripture, speak a known reference, review the suggestion, and stop.
7. Confirm the saved session contains finalized transcript text and can export.
8. Load the latest transcript snapshot into AI Presentation Creation.
9. Start and stop a short recording; verify the file opens.
10. If streaming is part of the service, test the configured RTMP destination.
11. Create a backup and confirm the UI reports that the archive was reopened and verified.
12. Force or observe one provider/output failure and confirm the operator sees a useful error and can retry or stop safely.

No P0 release should enable AI Auto Live by default, expose a provider key, or
ship an output integration that is only scaffolded.
