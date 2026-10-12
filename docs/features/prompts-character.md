# Prompts, character fidelity, and dashboard

Status: development specification with a first-import implementation. Research checked 2026-09-11. Depends on database/configuration revisions; preview inference depends on the inference adapter. The first-import CLI now preserves a locally supplied card and maps its main source fields verbatim. See [implemented import behavior](../character-import.md); richer upload/replacement and compatibility controls below remain planned.

Implemented API alignment: implemented routes are `GET /api/prompts`, `GET /api/prompts/preview?channel=telegram-text`, `GET /api/prompts/:id/history`, `GET /api/character` (safe import metadata), `PUT /api/prompts/:id` with `{ content, expectedVersion }`, and `PUT /api/prompts/order` with `{ ids, expectedOrderVersion }`. Catalog GET and order PUT return `{ prompts, orderVersion }`; IDs must contain every available section exactly once with Post-History Instructions last. Channel IDs remain `telegram-text`, `telegram-voice`, and `desktop-voice`; the two voice channels share one TTS Conversation Direction prompt. Text uses Text Conversation Direction. Invalid input currently returns 400, stale versions 409, and oversized requests 413. The richer import/bundle workflow below is a development target, not an additional implemented API.

## Outcome

Ember can see what each prompt is for, edit it, save it, and use the saved revision on the next message without restarting Valerie. The character designer preserves her established persona exactly as authored. Suggestions are separate drafts that Ember can compare and choose; importing is not permission to rewrite tone, remove warm language, change boundaries, or substitute a generic assistant persona.

## Data ownership and import

SillyTavern currently reads PNG `tEXt` character data, decodes base64, and prefers `ccv3` over `chara`. Character Card V2 includes description, personality, scenario, example dialogue, first/alternate greetings, system prompt, post-history instructions, creator notes, and optional character book/extensions. Those fields are not interchangeable. [SillyTavern parser](https://github.com/SillyTavern/SillyTavern/blob/release/src/character-card-parser.js), [Card V2 specification](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/README.md).

Import as follows:

1. Read the original bytes, check PNG signature, total length, chunk boundaries/CRC, and metadata size limits before decoding. Support V1, V2, and detected V3 shapes deliberately; do not assume every `chara` payload is V2.
2. Store the original PNG and SHA-256 in private runtime assets. Preserve decoded JSON text, both recognized chunks if present, parsed structure, and unrecognized fields. A future export must still have the original material.
3. Validate a version-specific schema with passthrough preservation. Display a warning for conflicting V2/V3 fields and show which payload was selected. Corrupt/unsupported metadata creates a failed import, never an empty successful character.
4. Create an import report mapping each source field to its destination, with byte-preserved authored strings and an explicit “not currently interpreted” list. Unknown extensions are preserved, not injected indiscriminately.
5. Set `displayName: "Valerie"` as a separate local override. Keep the imported name untouched. Rendering `{{char}}` as Valerie is a runtime substitution, not a mutation of the card.
6. Do not split a paragraph into “personality,” “relationship,” and “voice” by guessing. If the card mixes them in description, the editor presents that original description. Ember may author extra overlays later.

SillyTavern macros require an explicit compatibility pass. Initially resolve known inert values such as `{{char}}` and `{{user}}` into the final prompt, using the configured user display name. Preserve unresolved macros and report them. Stateful `setvar/getvar`, lorebook activation, depth placement, and regex extensions need documented implementations; silently stripping them can change authored behavior. Never execute embedded scripts or treat card extensions as installed tools. [SillyTavern macros](https://docs.sillytavern.app/usage/core-concepts/macros/).

## Proposed records

| Record | Essential fields |
| --- | --- |
| `character_import` | `id`, `sha256`, `originalAssetId`, `rawPayloads`, `selectedFormat`, `importedAt`, `mappingReport` |
| `character_profile` | `id`, `displayName`, `sourceImportId`, `sourceData`, `localOverlays`, `revision` |
| `prompt_definition` | stable `key`, title, purpose, applies-to channels/job types, variables, order, enabled state |
| `prompt_revision` | definition key, immutable body, revision number, author, timestamp, source/import reference |
| `prompt_bundle` | revision ID, ordered revision references, character revision, composition rules |
| `turn_context_snapshot` | turn ID, bundle/config revision, memory IDs/revisions, effective channel and generation settings |

Keep editable authored prose separate from operational instructions such as tool-result truthfulness and delivery formatting. No daily reflection job can edit imported fields or approved core prompts. It can create a suggestion with evidence and a proposed diff.

## Composition and channels

The implemented composer follows the saved catalog order for sections applicable to the chosen channel. It emits `# Title` plus each exact nonempty body, skips unrelated channels and future job prompts, and returns a separate headed post-history block. Catalog order and prompt versions are captured in one SQLite snapshot. Ember Knowledge describes Ember; Character Instructions controls behavior; Voice And Speech Patterns controls wording and rhythm, not ElevenLabs audio configuration.

Image Generation (`image-generation`) is editable in the same catalog with the usual revision history. It guides scene selection and the character-written wait acknowledgement. Configured image-capable Telegram turns and previews include its captured revision; speech and disabled image tools omit it. Tool schema validation and receipt rules remain enforced in code. The Conversation page separately shows each image's actual saved ComfyUI prompt under Image prompt.

The future turn pipeline adds runtime-owned context around those user-ordered sections: runtime/tool contract; character source and chosen overlays; user profile and core memory; channel behavior; selected history and relevant retrieved facts; active user request/job context. Honor imported post-history instructions as a separate placement rather than burying them in the general persona. Provider role limitations are handled in the adapter; the logical layers remain visible in the preview.

| Channel | Delivery behavior |
| --- | --- |
| `telegram-text` | Natural plain-text chat; authored `*actions*` and emojis may remain. No universal quotation wrapping, progress buttons, or tool chatter. |
| `telegram-voice` | Speakable prose without narrated stage directions. A voice-specific overlay preserves Valerie's personality. TTS cues are separate metadata or TTS-only text. |
| `desktop-voice` | Speakable prose, optional short segments, expression/gesture sidecars, local interruption support. |
| `dashboard.preview` | Explicitly selected target channel; preview never sends Telegram messages or runs side-effecting tools. |
| `reflection` / `heartbeat` / `reminder` | Separate task prompts with a bounded purpose and channel delivery rules. Reminder wording cannot alter reminder scheduling. |

Do not globally remove asterisks or brackets from stored messages. The voice path should begin with appropriate prose generation. Any compatibility transform operates on a separate speech copy, with tests for legitimate punctuation, markdown, mathematical expressions, and quoted text.

## Save and preview behavior

`GET /api/prompts` returns purpose, active version, and current content. `PUT /api/prompts/:id` accepts content plus `expectedVersion`; validate length and known variables, then commit the new immutable revision and active pointer in one transaction. A stale editor gets HTTP 409 and can reload to retrieve the current version. Validation errors should identify the invalid field; preserve the established 400/413 contract unless a future API version deliberately changes it. The dashboard must not claim “Saved” before that transaction returns.

At turn start, capture the active bundle revision once. Subsequent tool calls in that turn use the same bundle even if Ember saves a new prompt. The next newly queued turn captures the new bundle. A database-backed revision counter or in-process change event can invalidate caches; notification failure cannot make reads permanently stale.

“Preview assembled prompt” shows the exact effective layers, source fields, resolved variables, token estimate, omitted sections, and any unresolved macros. “Try reply” is an explicit inference action using a sample message and read-only/no tools. Mark usage/cost and the revision tested. A dry preview performs no model request. Character optimization suggestions show proposed changes side by side and do not auto-apply.

Dashboard pages begin with prompts/character, then add memories, reminders, activity, integrations, and schedules as those features land. This UI is exclusively Ember's personal control panel: direct labels, no product marketing, no account management, and no separate dashboard token. Use feature folders and a small shared form/API layer. Keep the service on loopback with authenticated SSH or owner-restricted Tailscale access, protected writes, origin checks, and safe text rendering; the private access path is an operational concern, not a prompt.

## Failure behavior

Missing card: show “Awaiting character import” and empty source-derived sections; project name and Valerie display name are already known. Invalid prompt: keep last valid bundle. Restart: active versions reload from SQLite. Conflicting edit: preserve the unsaved editor contents. Import failure: preserve the original failed upload privately for recovery only if the user chooses. Model ignores channel formatting: record the case for evaluation; do not silently alter imported source.

## Delivery phases and acceptance

**First:** prompt inventory with purposes, edit/save, revision history/rollback, assembled preview, server-side next-turn snapshot. **Then:** import/report, field-aware character editor, channel reply preview, compatibility support for actually present macros/lorebook data.

- Save a unique phrase, reload the dashboard, start a new turn, and prove the exact revision reached inference while the process start time stayed unchanged.
- Change a prompt while a tool loop is in progress: all requests in the original turn retain its revision; the following turn uses the new one.
- Concurrent editors cannot overwrite each other without a conflict; reverting preserves revision history.
- Round-trip fixtures preserve every authored string and unknown extension. Actual card import is compared field by field to its original payload before acceptance.
- Text examples keep actions visible; voice examples do not speak action markup or internal expression tags. Persona wording itself remains unchanged.
- Preview cannot send messages, create reminders, invoke scripts, or modify memory.
