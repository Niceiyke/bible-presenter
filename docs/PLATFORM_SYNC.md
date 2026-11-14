# Desktop Dashboard Sync

Desktop pulls published service plans from the Wordlyte platform through a
device-scoped credential.

## Configuration

Packaged builds must set:

```text
VITE_PLATFORM_API_URL=https://your-platform-api.example
```

Development defaults to `http://localhost:8787` when the variable is absent.
Production builds fail the Cloud sync panel with a configuration error rather
than silently pointing at localhost.

## Flow

1. The operator opens **Service Plan → Cloud**.
2. Rust reads the protected license device credential.
3. `platform_sync_pull` exchanges it at `POST /v1/device-auth/token`.
4. Rust pulls published service plans, presentation metadata, and any referenced
   presentation details.
5. The platform token stays inside the Rust process; it is never returned to the
   React frontend.
6. The operator selects a plan and appends supported items to the current local
   service.

## Supported item mapping

| Cloud type | Local result |
| --- | --- |
| `presentation` | `CustomSlide` from the referenced cloud slide |
| `scripture` | `Verse` resolved from the installed local Bible version |
| `note` | text `CustomSlide` |
| `custom` | text `CustomSlide` from `notes`/`payload.text` |
| `song` | warning; song content sync is not implemented yet |
| `media` | warning; media remains local-only |

Duplicate local entry IDs are skipped when appending, so pulling the same plan
twice does not duplicate items.

## Pull behavior

- Only published plans are returned by the platform.
- The current command performs a full pull; no sync cursor is persisted yet.
- Cloud entries are appended to the current service, not merged or deleted.
- Conflicts and deletion tombstones remain future work.
