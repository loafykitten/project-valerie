# Telegram conversations, images, and voice

Status: text, incoming images and [character-requested ComfyUI images](character-images.md) are implemented; voice remains a development specification. Research checked 2026-09-11. This broader design depends on inference, prompt channels, durable inbox/outbox, private asset storage, and activity. ElevenLabs voice is not verified here.

## Text experience and transport

Valerie should feel like a person texting: complete conversational messages, occasional natural paragraph-sized bubbles, normal emoji/action text when the character calls for it. Do not routinely show typing actions, progress edits, command keyboards, memory-save notices, tool traces, or “I am processing your request” wrappers. A genuinely long operation can produce a short in-character acknowledgment if helpful. Technical detail belongs in the dashboard or a direct troubleshooting conversation.

Telegram supports polling or webhooks, but not both simultaneously. `sendMessage` is limited to 4096 characters after entity parsing; `sendVoice` accepts OGG/Opus, MP3, or M4A, with a documented current upload limit of 50 MB. `sendPhoto` has image-specific limits. Use multipart uploads for private local media. [Telegram updates](https://core.telegram.org/bots/api#getupdates), [text](https://core.telegram.org/bots/api#sendmessage), [voice](https://core.telegram.org/bots/api#sendvoice), [photos](https://core.telegram.org/bots/api#sendphoto).

Use one long-polling owner on the homelab initially. Pin the permitted private chat and user IDs; validate both before loading history or performing inference. Treat incoming user text, photo attachments, and captions as one source message. A startup check identifies any existing webhook but does not silently discard updates. Before cutover, stop and disable LegacyNudges and verify that it cannot resume polling the same token.

Persist every accepted update in `channel_inbox` with unique `(channel, externalUpdateId)` before advancing the polling offset. Queue processing separately so provider latency does not delay ingestion. Make edit handling explicit: archive the revision, cancel an unstarted turn if possible, and do not rerun completed side effects merely because a user edited spelling.

Outbound delivery is a durable record:

```ts
type Delivery = {
  id: string;
  turnId: string;
  occurrenceId?: string;
  channel: "telegram";
  kind: "text" | "photo" | "voice";
  payloadRef: string;
  sequence: number;
  status: "queued" | "sending" | "sent" | "retryable" | "unknown" | "failed";
  externalMessageId?: string;
  attempts: number;
  nextAttemptAt?: string;
};
```

Archive what was actually sent, including split-message ordering and media caption. Mark success only after the returned message ID is saved. Network loss after submission can leave an uncertain outcome; Telegram does not give this application a general exactly-once transaction. Do not blindly resend uncertain reminders indefinitely. Show ambiguity in activity and apply a bounded delivery policy appropriate to the reminder's importance.

Use plain text by default (`parse_mode` absent), preserving literal `*actions*`. If richer formatting is later desired, derive Telegram entities from a small safe renderer; never send raw model-generated MarkdownV2 without escaping. Split overlong text at paragraphs/sentence boundaries with room for formatting, and avoid splitting Unicode graphemes. A multipart reply is still one logical turn.

## Locally hosted ComfyUI

ComfyUI's local server accepts workflows through `/prompt`, exposes progress on `/ws`, and stores completed outputs under `/history/{prompt_id}` for retrieval through `/view`. Workflow inputs are captured when submitted. These are local-server routes, distinct from Comfy Cloud's routes. [ComfyUI routes](https://docs.comfy.org/development/comfyui-server/comms_routes), [server overview](https://docs.comfy.org/development/comfyui-server/comms_overview).

Valerie chooses an approved `workflowKey` and user-facing image intention. The adapter maps bounded prompt/seed/size fields into a stored API-format workflow template. Do not ask a model to construct arbitrary node graphs or change filesystem paths. A configured workflow revision records model/checkpoint dependencies, permitted input node IDs, default dimensions, seed behavior, expected output nodes, and maximum runtime. Credentials and local hostnames stay server-side.

`image_job` stores job ID, originating turn, workflow revision/hash, sanitized inputs, Comfy `prompt_id`, status, output asset IDs, timestamps, and error. Persist intent before submission; on reconnect use known history/queue status rather than resubmitting an expensive job. If submission outcome is unknown before a `prompt_id` arrives, flag it for reconciliation instead of creating duplicates. Poll history as a fallback when the WebSocket is unavailable.

Only download output names/subfolders/types returned for the matched job and expected output nodes. Validate image MIME, bytes, and dimensions; make a Telegram-compatible derivative if necessary while retaining the private original. Neither inference nor the browser can request arbitrary local paths through the media endpoint. Expiring authenticated asset URLs can serve dashboard previews; Telegram receives uploaded bytes rather than private-network URLs.

Cancellation needs care: do not call a server-wide interrupt if the Comfy instance is also used by Ember or other jobs. Cancel a queued owned job through supported scoped operations; running-job interruption requires verified ownership/exclusivity. If cancellation cannot be isolated, stop waiting/sending and report the job's actual remaining state.

## ElevenLabs voice and speech copies

Use a dedicated `telegram-voice` prompt for a reply intended as a voice note. Store `displayText`/transcript and `speechText` separately. TTS-only tags must not leak into the visible chat or overwrite authored source messages. For a text message later read aloud, derive a speech copy deliberately; do not indiscriminately strip all brackets/asterisks from the archive.

ElevenLabs can return audio and character-level alignment from `/with-timestamps`. Audio tags are supported by Eleven v3, while SSML support and delivery controls differ by model. Tags guide delivery; they are not guaranteed animation cues or word-level timing. Voice/model/account compatibility must be verified with the selected voice. [Timing API](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps), [audio tags](https://elevenlabs.io/docs/help-center/product/core-capabilities/text-to-speech/how-do-audio-tags-work-with-eleven-v3-alpha), [model-specific speech guidance](https://elevenlabs.io/docs/eleven-creative/playground/text-to-speech).

Start with ordinary MP3 output and multipart `sendVoice`; conversion to OGG is optional, not a blanket dependency. Verify on Ember's Telegram client that it displays as a voice message. Use explicit `voiceId`, `modelId`, bounded settings, output format, and text revision. Store a synthesis key derived from all of these plus speech text, so an upload retry can reuse generated audio and changing a model never silently reuses the previous model's result. Do not use provider speech history as the sole cache.

`speech_asset` stores origin turn, transcript, speech-text hash, voice/model/settings revision, audio asset, duration, optional alignment, cost/usage if known, and synthesis status. Character timings are retained for future desktop synchronization; amplitude-driven lip sync can work without them. Sending to Telegram and playback on the desktop are separate deliveries of the same speech asset, avoiding accidental double playback.

If TTS fails, provide the intended words as a text fallback only under the configured fallback policy and record that voice failed. Authentication and paid-voice/account failures are actionable configuration errors, not endless retries. If upload fails after successful synthesis, retry the upload with the existing asset. A voice note must not require a caption/transcript bubble unless Ember wants one.

## Failure behavior and acceptance

Suggested initial bounds: one interactive inference at a time per conversation, one owned Comfy job at a time, one TTS synthesis at a time, media size/time limits, and finite retry counts with jitter. Telegram 429 respects provider retry timing; configuration failures remain visible in the dashboard. Provider outage responses should be brief, accurate, and conversational.

**First:** text inbox/outbox, permissions, restart recovery and archive. **Then:** Comfy template job flow and voice synthesis/upload. **Later:** incoming image understanding/voice transcription if chosen, desktop shared playback, richer formatting only where it improves the experience.

- Duplicate inbound updates create one turn; restart after persistence and before offset advance does not duplicate a reply or tool effect.
- Restart after synthesis or image completion reuses the saved asset. Long-running image work does not monopolize the conversation.
- Actual Telegram client tests verify text, emoji/actions, a long split reply, a photo, and a playable voice note.
- Missing Comfy node/model errors identify the failed workflow in the dashboard; they do not expose server paths in casual chat.
- An unrelated Comfy job is never interrupted by Valerie's cancel operation.
- Voice tests cover action-rich text, ordinary punctuation, TTS cues, and a voice/model change; displayed words remain faithful and audio contains no unintended stage directions.
- Ambiguous sends remain `unknown`; tests do not falsely claim exactly-once external delivery.
