# Text conversations

Owner: core conversations (SQLite, snapshots, settings, inbox/outbox); inference (Neuralwatt contracts); server Telegram (transport/worker), runtime (one lifecycle); dashboard Conversation (settings and actual outcomes).

## Scope and model

This milestone implements complete text replies, now extended to [incoming Telegram images](incoming-images.md) and [character-requested ComfyUI images](character-images.md). The selected account model is `glm-5.3-flash-flex`, verified through Neuralwatt's authenticated customer catalog. [Flex inference](flex-inference.md) streams internally while delivering complete Telegram replies, with actual tier receipts and a bounded capacity wait. Low reasoning is selected to keep conversation latency bounded; the model requires reasoning. The initial output allowance is 4,096 tokens, including reasoning. Temperature stays at the provider default. The image tool is supplied only when configured and supported by pinned capabilities; hosted tools remain explicitly opted out. [Memory retrieval and bounded tools](memory-reflection.md) now complement the recent-history snapshot. Reminders, voice and other external actions remain unavailable; the turn runtime states actual capabilities separately from authored character prose.

Model selection and limits are verified against fresh account capabilities when settings are saved. Settings revisions retain the exact normalized capability snapshot. Credentials remain in the API environment and never enter settings, history, browser bundles, or activity metadata. A catalog or provider failure never selects a fallback model.

## History and snapshots

Every accepted private owner text is archived once. A serialized turn captures saved prompt text, section order/version, character import provenance, Post-History Instructions, inference settings/capabilities, current local time, and recent history in one SQLite transaction. Prefix sections keep the saved order and headings. Current user input follows recent history; Post-History Instructions is the final system message. No saved authored field is rewritten.

The starting history policy is a sliding **48-hour window** with a **96,000 conservative token allowance** and a **131,072 total context limit**. These values are editable in Conversation. Each UTF-8 byte is counted as one token plus message overhead; this is a deliberately conservative bound, not a tokenizer measurement. Output and a 2,048-token safety margin are reserved first. Prompt/current-input overflow fails visibly instead of truncating authored instructions or the current message.

Select the newest whole delivered exchanges within both limits, in chronological order. Failed/unknown exchanges are omitted, retaining older confirmed context without telling the model an unseen reply was received. The scan is bounded to 1,001 candidate turns. The dashboard shows how many exchanges each turn included. A very busy day or unusually long reply can fill the budget before 48 hours; there is no guarantee that an entire time window fits.

The archive is independent from inference context. Messages are not deleted when they leave the window. There is no midnight reset and no artificial chat boundary every day or two. Future memory can retrieve older topic evidence alongside this recent window. Automatic summaries and inferred facts are intentionally absent until memory has provenance and update rules.

## Time and waking-day continuity

Each new snapshot includes the current America/Chicago clock and current input arrival time. Earlier whole exchanges have separate system metadata with the owner input's arrival and the assistant reply's final confirmed delivery time. Missing delivery timestamps are labeled unavailable. Date, AM/PM and timezone abbreviation distinguish midnight and repeated daylight-saving hours; delayed replies do not rewrite the original input time. Timestamp overhead counts toward the same bounded history budget. Original user/assistant text and the archived evidence remain verbatim, and retries retain their captured times and prompt revisions.

**Prompts → Time And Continuity**, beside Ember Knowledge, holds editable guidance distinguishing a calendar date from Ember's waking day. Midnight alone does not imply sleep, waking or a missed meal. Actual sleep/wake updates and current corrections outrank the latest available routine; a typical bedtime is not proof of sleep. Personal routines belong in **Memory** and can change over time; when relevant context is missing, Valerie can look it up. Routines are saved through ordinary chat; this change does not insert or pin one. This adds evidence and instructions for model reasoning, not an automatic sleep detector or a changed calendar clock.

**Prompts → Memory Use** follows Time And Continuity and controls recall, quoted saves, correction of rejected calls and truthful acknowledgements in Valerie's own voice. It applies when text memory tools are available. Both new sections retain revision history and owner ordering; an intentionally empty edit remains empty. Existing authored sections are preserved.

## Telegram and durability

Only the configured owner sender in her private chat is accepted; groups, other senders, bot messages and edits are ignored. Supported input includes text, photos and image documents with captions. Unsupported image formats get a durable failure; unrelated media is ignored. Startup verifies bot identity and absence of a webhook. The durable cursor is bound to that bot. A different bot requires explicit migration rather than sharing another bot's update cursor.

The inbox insertion and next polling offset commit together. Repeated update IDs and message IDs do not create another turn. A single owned worker serializes inference and delivery. The process runtime starts it once, retains it through HTTP reloads, and aborts/joins it before SQLite closes. A durable worker lease and fencing prevent another Valerie process from polling/sending with the same database. This cannot stop an unrelated application using the token: LegacyNudges must remain stopped.

Completed generation and outgoing chunks commit atomically. Telegram sends plain text, preserves emoji and authored action markers, and splits long replies without exceeding 4,096 UTF-16 units or breaking surrogate pairs. No typing notices, routine buttons, or progress wrappers are sent. Each confirmed send stores Telegram's message receipt. Per-chunk ordering prevents a later chunk overtaking an earlier retry.

Definitive rate limits respect retry timing with a finite attempt bound. Authentication/configuration failures require action. A timeout, disconnected response, process crash during send, or ambiguous server failure becomes `unknown`; there is no automatic resend because Telegram has no send-message idempotency key. Remaining chunks from a failed/unknown delivery are suppressed. This prevents blind duplicates but cannot promise exactly-once external delivery. [Telegram update acknowledgments and sendMessage](https://core.telegram.org/bots/api), [Neuralwatt model contracts](https://docs.neuralwatt.com/api/models).

An interrupted generation can be retried using its original snapshot. An incomplete model response is recorded as failed instead of sending partial reasoning or abruptly cut text. The dashboard can retry the latest failed turn if no delivery was attempted and no newer input exists; after changing settings, send a new message to use the new version. Uncertain deliveries are visible in Conversation and Activity and are never silently called successful.

## Acceptance and verification

Deterministic fictional tests cover duplicate inbound updates, cursor atomicity, private sender filtering, snapshot consistency, history budget/cutoffs, ordered bursts, generation recovery, delivery receipts, partial send failures, unknown sends, lease conflicts, cancellation, model validation and HTTP setting conflicts. The runtime tests verify that HTTP reloads cannot create a second worker and shutdown joins it before closing the database.

## Proactive continuity

[Casual heartbeats](heartbeats.md) now share the existing Telegram worker and delivery ownership. Only receipt-confirmed heartbeat text enters later conversation snapshots and archive search as assistant evidence. A heartbeat never creates a synthetic owner input or authorizes a memory save. Its generation yields promptly to a new owner message, and prepared text is checked again before sending. Heartbeat settings remain in the dedicated dashboard; reminder scheduling and general background jobs remain separate.
