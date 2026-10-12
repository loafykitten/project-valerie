# Editing delivered replies

Status: implemented and activated on homelab September 16, 2026 UTC.

Owner: core conversations owns edit requests, revisions and confirmed history; the Telegram worker owns remote execution; Conversation owns the editor. Scope: owner-authored edits to fully delivered conversational text replies. No model tool can edit history.

The Conversation page offers Edit reply and Load older turns. Replies split across Telegram messages expose each part separately; each part accepts 1–4,096 UTF-16 code units with intact Unicode. The parts concatenate exactly as delivered. Revision history can populate a draft from an older version; saving that draft creates a new revision.

An edit request captures a stable request ID, delivery ID, expected text version and replacement text. HTTP queues it durably without provider work. Repeated submission of the same ID/content is idempotent. Concurrent, stale and cross-owner edits are rejected. The existing worker processes edits using its polling lease, without an extra poller or timer in HTTP routes.

Telegram confirmation must identify the expected message, chat and exact text. Only then does one SQLite transaction append an immutable text revision, replace the delivered chunk and assembled turn text, and refresh archive search. The original model result, earlier turn snapshots, owner inputs, delivery timestamps and reminder/memory records remain unchanged. Future turns read the revised conversation; already-captured turns retain their old context. Conversation-search cursors are invalidated by revision changes.

A rejected edit retains the last confirmed history and exposes explicit retry. Rate-limit pauses are honored. Network errors, timeouts, malformed success responses and interrupted in-flight edits are unknown, never automatically retried. An unknown edit blocks a different replacement until it is resolved. Explicit retry targets the same message and text; Telegram's exact `message is not modified` response confirms that the requested content already matches. Each attempt has a retained result and worker fence. Queued edits survive restart.

The dashboard preserves unsaved drafts during polling and version conflicts. It shows queued, sending, confirmed, failed and uncertain results distinctly. A durable request's proposed text stays available while confirmation is pending. The editor never reports a successful save from queue acceptance alone.

## Acceptance

- Confirmed changes reach Telegram, the dashboard, newly captured conversation context and archive search.
- Unknown/failed outcomes do not replace confirmed history; explicit same-target retries reconcile uncertainty without sending a new message.
- Original generations and revision history survive edits/restores/restarts; old turn snapshots are immutable.
- Multipart replies, stale drafts, hostile origins/hosts, owner boundaries and Unicode/size limits are covered by deterministic tests.
- The existing background lifecycle stays single-worker and requires a schema/runtime-contract restart.

## Limits

This first editor covers ordinary conversation replies with confirmed delivery of every part. Heartbeats, scheduled reminders/check-ins, notices, photos and captions are not editable here. Editing wording does not undo tool actions, reschedule reminders, alter saved memories, regenerate later replies or permanently train the model. Older turns are paged in batches of twenty; revisions in batches of fifty.

Telegram and SQLite cannot commit atomically together. Unknown status makes any possible mismatch explicit. An already-running model turn may still finish using its earlier captured revision. No permanent style improvement is promised.

See the [Telegram editing contract](https://core.telegram.org/bots/api#editmessagetext).
