# AI Presentation Assistant

## Product boundary

The AI Presentation Assistant creates editable Studio drafts from an operator-supplied topic or notes. It is an authoring tool, not a live-output controller:

- Generation never stages a slide, changes the program feed, or initiates Go Live.
- Accepted output is compiled into Wordlyte's normal `CustomPresentation` and `CustomSlide` model.
- The operator previews the outline before creating the deck and can edit every generated element afterward.
- Network, provider, credential, cancellation, or validation failures do not affect existing presentations or normal projection.

## Initial OpenAI slice

1. **Settings → AI Creation** stores a church-owned OpenAI key in the separate `openai-api-key.dpapi` file using current-user Windows DPAPI. The key is not returned to React and is excluded from Wordlyte backups.
2. **Presentations → Create with AI** accepts a topic, optional notes, audience, presentation type, slide count, installed Bible version, speaker-note preference, and key-point highlighting preference.
3. The Rust backend calls the OpenAI Responses API with strict Structured Outputs. Source notes are explicitly treated as content rather than instructions.
4. The provider returns a semantic deck plan, never raw slide JSON, HTML, element coordinates, IDs, local paths, or Bible verse text.
5. The backend applies independent size, enum, markup, and exact-emphasis validation after schema validation.
6. Generated Scripture references are resolved against the installed Bible database. Verse text always comes from Wordlyte; unresolved references produce visible warnings and are not inserted as Scripture text.
7. The frontend deterministically compiles the validated plan into native title, content, quote, and Scripture layouts. Key phrases become safe ProseMirror bold/accent marks using the deck theme.
8. Generation can be cancelled while the provider request is active. Draft creation still requires a separate operator action after outline review.

## Runtime flow

```text
topic / pasted notes
  -> Rust request validation
  -> OpenAI Responses API structured deck plan
  -> strict local plan validation
  -> installed-Bible reference resolution
  -> operator outline preview and warnings
  -> deterministic native slide compiler
  -> save_studio_presentation
  -> normal editable Slide Editor
  -> Stage and Go Live remain separate operator actions
```

## Privacy and persistence

- Topic and notes are sent only when the operator selects **Generate outline**.
- Generated plans remain in frontend memory until accepted or dismissed.
- Accepted decks contain normal presentation content and are included in ordinary backups.
- The OpenAI credential remains in the app-data `secrets` directory, which backup creation does not include.
- API keys and source notes must not be written to application logs.

## Next implementation slices

- Contextual Slide Editor actions: shorten, rewrite, turn into bullets, highlight key phrases, and generate speaker notes.
- Regenerate one slide without replacing the rest of a deck.
- Deterministic text-density, overflow, and contrast checks.
- Add an accepted deck to the Service Plan in one action.
- Manual capture of a recent live-transcript thought into a chosen draft presentation.

## Structured prayer DOCX import

Studio also provides a deterministic **Prayer DOCX** importer for weekly intercession documents. This path does not send the document to OpenAI:

1. The Rust backend reads only `word/document.xml` from an operator-selected `.docx`, with archive and uncompressed-size limits.
2. It reconstructs Word text runs, recognizes weekday headings and numbered intercessions, and tolerates common source formatting errors such as missing spaces or colons.
3. Every extracted reference is resolved against the selected installed Bible version; document-provided verse text is ignored.
4. The operator previews day/prayer counts and verification warnings.
5. The deterministic compiler creates one native deck per day, with a title slide followed by separate prayer and verified-Scripture slides for every intercession.

The supplied November 2–6, 2026 qualification document parses as five daily decks with five intercessions each.

## Contextual Slide Editor actions

The Slide Editor uses the same encrypted OpenAI credential and provider-neutral semantic boundary for contextual draft changes:

- Selected editable text: shorten, rewrite, convert to bullets, and highlight exact key phrases.
- Current slide: generate speaker notes or regenerate one slide.
- Every request uses a strict single-slide Structured Output schema and treats existing presentation content as untrusted source material.
- A side-by-side preview requires explicit operator confirmation before applying.
- Highlighting cannot replace source wording. Single-slide regeneration preserves the existing background, element IDs, geometry, media, and styling where editable text boxes exist.
- Any returned Scripture reference is limited, resolved locally, and populated from installed Bible data; provider verse text is never accepted.
- Applying a suggestion creates one editor history entry and never invokes staging or live-output commands.
