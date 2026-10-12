# @valerie/core

Bun-native persistence and domain services for Project Valerie. There are no runtime package dependencies. The package exports its TypeScript entry point from `src/index.ts` and requires Bun for SQLite.

## Store

`openStore(path: string): Store` creates the parent directory when needed, opens SQLite with a five-second busy timeout and foreign keys, enables WAL for on-disk databases, and applies versioned migrations in an immediate transaction. `Store` exposes `db: Database` for future domain migrations and `close()` for shutdown. `:memory:` is supported for tests. Do not expose this file over a network filesystem.

## Prompts

`createPromptService(store)` seeds nine stable prompts only when absent:

`identity`, `personality`, `relationship`, `voice`, `channel.telegram-text`, `channel.telegram-voice`, `reflection`, `heartbeat`, `reminders`.

Only the identity (`Your name is Valerie.`) and operational channel formatting prompts are prefilled. Ember Knowledge, relationship, voice, reflection, heartbeat, and reminder sections begin without authored text. Import adds separate source fields without filling or overwriting these overlays. Startup never replaces existing prompt content.

- `list(): Prompt[]` returns `{ id, title, purpose, content, version, updatedAt }` in dashboard order.
- `get(id): Prompt | undefined` reads current persisted content.
- `update(id, { content, expectedVersion }): Prompt` atomically saves the exact string and a revision. Content is limited to 256 KiB. `PromptConflictError` includes `promptId`, `expectedVersion`, and `currentVersion`. A missing ID throws `PromptNotFoundError`.
- `history(id): PromptRevision[]` returns `{ promptId, version, content, createdAt }`, newest first, including the initial seed revision.
- `compose(channel): PromptSnapshot` reads one consistent transaction for `telegram-text`, `telegram-voice`, or `desktop-voice`. It includes identity, imported system prompt/description/personality/scenario when active, Ember Knowledge and relationship/voice instructions, and the selected channel. Telegram text also includes exact dialogue examples under their title heading. First message, creator notes, lorebook, and extensions are never injected. `content` is the system prefix; `postHistoryContent` returns imported post-history instructions separately with `postHistoryPlacement: "after-history"`. Future inference orchestration must place this separate block after history. `prompts`, `versions`, `placements`, and `characterImportId` record exact provenance, including post-history and text examples when used. Reflection, heartbeat, and reminder prompts belong to their future job-specific composition paths.

There is no prompt cache: the next composition sees the next saved revision without a process restart. In-flight snapshots retain their original values. Updates from multiple store connections serialize at SQLite's write lock; optimistic version checks reject stale edits.

## Activity

`createActivityService(store)` supplies:

- `append({ kind, summary, status?, metadata? }): Activity`, defaulting to `succeeded`. Status is `succeeded | failed | pending`.
- `get(id): Activity | undefined`.
- `list({ query?, since?, limit?, status? } = {}): Activity[]`, newest first. Default window: seven days, maximum returned rows: 100, configurable up to 1,000. `since` accepts a Date or date string. Search is a case-insensitive literal substring of `kind` or `summary`, not metadata.
- `outstanding(): Activity[]`, all pending entries of any age, oldest first. The seven-day window never hides outstanding work.
- `updateStatus(id, status): Activity` resolves or reopens an activity. Append a separate result entry when recording outcome details.

`Activity` has `{ id, kind, summary, status, createdAt, metadataJson }`. Times are UTC ISO 8601 strings. Metadata is JSON, limited to 64 KiB. Entries remain durable; this foundation does not delete old history or implement compaction. SQLite's built-in case folding is primarily ASCII; multilingual search can be added when needed. Callers must redact credentials and private payloads before logging them.

## Prompt ordering and assembly

`catalog(): { prompts: Prompt[], orderVersion: number }` reads content and order together; `list()` returns its ordered prompts for existing callers. `reorder({ ids, expectedOrderVersion })` requires an exact permutation of the current catalog and a current order version. Post-History Instructions must be last. Stale versions/catalogs throw `PromptOrderConflictError`; malformed permutations or moving the pinned section throw `PromptOrderValidationError`. A no-op keeps the version unchanged.

Migration `003-prompt-order` stores one independent order record. Catalog initialization and character import reconcile additions/removals inside their write transactions; new sections append before after-history. Reordering changes neither authored content, prompt versions, edit timestamps nor revision history. The stable `personality` ID now displays Ember Knowledge and retains any existing text/history.

`compose(channel)` captures `orderVersion` with prompt versions and exact selected records in one read snapshot. Shared sections and the chosen channel follow catalog order; other channels and future reflection/heartbeat/reminder jobs are excluded. Nonempty sections use `# Title\n\n` followed by untouched body text. `postHistoryContent` includes its own title heading and remains separate with `postHistoryPlacement: "after-history"`. A later save/reorder does not mutate a captured snapshot.

## Character-card preview

`parseCharacterCard(bytes: Uint8Array): CharacterCardPreview` parses a legacy JSON card, Character Card v2/v3 JSON, or a PNG with base64 UTF-8 JSON in `chara` or `ccv3` tEXt metadata. If both keywords occur, v3 takes precedence; duplicate identical keywords are rejected as ambiguous. PNG chunk bounds, checksums, header, image-data presence, and end marker are checked. Pixel data is not decoded or rendered. Compressed zTXt/iTXt and non-PNG image formats are not currently supported.

The preview includes `{ format, metadataKeyword, originalBytes, sha256, jsonText, card, fields }`. `originalBytes` is an independent copy; `jsonText` preserves decoded JSON formatting; `card` retains unknown properties; `fields` exposes recognized authored text fields without trimming, macro expansion, name substitution, or prompt mapping. Maximum source: 16 MiB; maximum decoded metadata or raw JSON: 1 MiB. Invalid input throws `CharacterCardError`.

Parsing cannot write to the database. The full source is authoritative for fidelity; JavaScript's parsed representation does not preserve numeric literals or JSON whitespace independently of `jsonText`.

## Character import

`createCharacterService(store)` provides:

- `getActive(): CharacterImportMetadata | null`: source/display names, filename, hash, import time, format, field mappings and preservation counts. No authored prompt content or arbitrary extension names/values are returned.
- `import(bytes, { sourceFilename, displayName?, expectedActiveImportId }): { character, imported }`: default display name `Valerie`; `expectedActiveImportId` must match the active ID or be `null` for an initial import. Source filenames must be basenames. The complete source, exact selected JSON, mapping report, six source prompt definitions/revisions, active pointer, and content-free activity record commit together. Mapped fields have the same 256 KiB bound as editable prompts; the parser applies source/metadata bounds first. Nonempty destination prompts block import. Empty preexisting destinations receive a new revision.
- `getOriginal(id): { originalBytes, jsonText } | undefined`: local fidelity verification only, returning an independent byte copy. Never expose this through an HTTP endpoint.

The dedicated prompt destinations are `character.description`, `character.personality`, `character.scenario`, `character.examples`, `character.system-prompt`, and `character.post-history`. Every available source string is copied verbatim; absent fields get empty prompts with `sourcePresent: false`. The original name stays in `sourceName`; the independent display override does not rewrite source text or the identity prompt. Macros, conditional lorebook entries, greetings, depth prompts and unknown extensions remain preserved data, with no evaluation or extraction of relationship prose.

An exact active source hash is idempotent after the active ID check: it returns `imported: false` and leaves later prompt edits untouched. A different source is refused until an explicit replacement workflow exists. `CharacterImportConflictError` reports stale active IDs, occupied destination prompts, and unsupported replacement. Original import rows have SQLite immutability guards; prompt edits remain independently revisioned. The `002-character-import` migration preserves existing prompt revisions.

## Verification

Run `bun test packages/core/test` from the repository root. Fictional fixtures exercise prompt conflict protection, immediate composition, reopening and concurrent connections, exact source/card preservation, malformed PNG rejection, transactional import rollback, import idempotency, text/voice/post-history separation, literal activity search, and pending work beyond the recent-activity window.

No reminders, reflection jobs, scheduled tasks, inference providers, or external integrations run in this package yet.

## Shared Conversation Direction

Text Conversation Direction retains `channel.telegram-text`. TTS Conversation Direction retains `channel.telegram-voice` and is shared by both `telegram-voice` and `desktop-voice` composition. Migration `004-shared-tts` combines existing voice bodies, generalizes only the known scaffold opening, and deduplicates equivalent bodies; distinct custom text is retained. The shared section receives a new content revision, and the retired desktop section is removed with its revisions after a private pre-deployment backup. Its earlier position is used when merging order entries. Other prompt text/history and original character data remain untouched.
