# Private character import

`bun character:import /absolute/path/to/card.png` imports the first character into the configured local SQLite database. JSON cards are also accepted. This command does not send messages, call inference, modify the Downloads source, or activate any embedded runtime instructions.

## Preservation and mapping

The original file bytes, SHA-256, and exact selected decoded JSON are retained in an immutable import record. A separate display-name override is `Valerie`; the original name remains in metadata and in every authored string. When both PNG payloads exist, the parser selects `ccv3`; the original PNG retains both payloads. Unknown fields, lorebook entries, image prompts and bundled soul files remain in the source, including formatting differences between parallel representations.

| Source field | Editable prompt | Current use |
| --- | --- | --- |
| `description` | `character.description` | Shared character context |
| `personality` | `character.personality` | Shared character context |
| `scenario` | `character.scenario` | Shared character context |
| `system_prompt` | `character.system-prompt` | Shared character instructions |
| `mes_example` | `character.examples` | Raw text-only examples, framed separately during composition |
| `post_history_instructions` | `character.post-history` | Separate `postHistoryContent` block for after-history placement |
| `first_mes` | None | Original archive only; no editable prompt |
| `creator_notes` | None | Original archive only; no editable prompt |

Catalog activation removes the retired first-message and creator-note prompts and their editable revision rows. Original source bytes, JSON, and historical import reports remain unchanged; a private database backup retains the pre-removal revisions. Catalog labels and descriptions are refreshed without changing saved content, revision numbers, or edit timestamps.

The `personality` ID now displays **Ember Knowledge**, for facts about Ember. Its existing text/history is preserved; the importer leaves it, `relationship`, and `voice` unchanged. The importer does not split mixed description paragraphs, promote conditional lore into always-present relationship text, regenerate fields from soul files, or correct spelling/template variables. Every mapped value remains exactly equal to its source string at import.

## Durability and conflicts

Import writes and source-prompt revisions commit in one SQLite transaction. The active import ID guards concurrent attempts. Reimporting the same source is a no-op and preserves later prompt edits. A different source is refused after activation until an explicit replacement workflow exists. Preexisting nonempty source destinations are protected.

The CLI backs up an existing database before opening it for migration/import, then reopens it and verifies original bytes, exact selected JSON and newly mapped fields. Private `original.png`/`original.json`, `card.json`, and a verification report are stored under `character-imports/<sha256>/` beside the database. Keep that directory and backups outside Git. With defaults, they are inside ignored `data/`.

The main fields appear in the existing prompt editor with version history. On the private dashboard, `GET /api/character` exposes source/display name, hash, source filename, mappings and deferred-feature counts; it does not expose the original image or raw embedded extension contents. Access is through loopback, SSH or owner-restricted Tailscale rather than a dashboard token. The saved catalog order determines the order of applicable system sections. Each nonempty body receives its title as a Markdown H1 without altering stored prose. Post-History Instructions is pinned last in the catalog and previewed separately, with its own heading, for delivery after conversation history. New imported sections append to existing order before that pinned section, and catalog changes advance the order version. The future conversation service must consume that placement explicitly rather than using only the prefix `content` string.

## Compatibility limits

Macro expansion is not implemented. Known variables and malformed variables remain visible exactly as authored. Conditional lorebook activation, depth-prompt placement, image-generation settings, alternate greetings and YuriOS execution are preserved as data and need their own explicit integration. A lorebook rule mentioning a time does not create a reminder.

Tests use fictional cards and verify atomic failure, no silent replacement, byte/string fidelity, idempotency, reopening, and text/voice/post-history separation. Actual source verification runs locally; original character content must never enter a review snapshot or committed test fixture.
