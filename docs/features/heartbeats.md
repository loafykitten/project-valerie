# Casual heartbeats

Owner: core heartbeat state/context, server Telegram lifecycle/generation, and dashboard Heartbeats.
Implemented and activated on homelab 2026-09-15.

## Experience

A heartbeat is an opportunity for a brief, natural message or silence. It can be simple warmth, a playful callback, interest in a shared topic, a gentle invitation to reconnect, or occasional relevant encouragement. An unanswered ordinary reply does not prohibit a later warm invitation. The model does not need to cover personal-growth practices each day.

The editable **Prompts → Casual Heartbeat** section works with the existing character, relationship, and text voice. It normally asks for one to three short sentences, roughly 15–60 words, under the saved character ceiling (initially 480). Short in-character actions remain possible. Existing authored character and relationship prose is preserved.

Messages may be allowed at any hour, including a quiet note when sleep seems plausible. Saved sleep context and the latest available messages inform the tone; a fresh waking update takes precedence over the usual routine. Sleep is a contextual judgment, not a detector or proof. The model may stay quiet.

## Owner controls

**Heartbeats** shows saved enablement separately from actual worker availability, policy eligibility, the next opportunity, recent outcomes, and daily/unanswered use. Settings use optimistic versions and retain unsaved drafts through navigation and pause/resume.

- Any-time delivery or a chosen local time window, including overnight windows.
- Timezone and the boundary at which the daily allowance resets. Equal start/end times mean any time; the shared time remains the allowance boundary.
- Randomized opportunity spacing, minimum conversation idle time, daily ceiling, unanswered ceiling, and message length.
- Indefinite pause, resume, and an API-supported pause deadline.

Code defaults are disabled, 09:00–23:00 America/Chicago, 180–360 minutes between opportunities, 60 minutes of conversational quiet, two messages per allowance period, two unanswered heartbeats, and 480 characters. Caps can be adjusted from one to eight. Settings are authoritative application records; a memory note does not schedule or pause anything. Chat tools for editing heartbeat settings are not part of this version.

## Scheduling and delivery

Migration 011 stores settings/revisions, the next opportunity, and individual runs. A timer wakes the existing Telegram worker; the stored timestamp owns the schedule. The one Telegram polling lease and an exact per-run fence protect work. No second poller or broker is added.

Before inference, code checks enablement/pause, allowed hours, known owner chat/input, pending direct conversation, minimum idle/spacing, daily and unanswered caps, and existing active work. Unanswered counting uses accepted owner-input order, not timestamps or the rolling context window. Midnight and restart cannot reset it.

An eligible run pins settings, owner-input watermark, prompts, inference settings, memory, and conversation evidence. Generation runs alongside the normal conversation loop. A fresh accepted owner message aborts it promptly. Before a prepared text is handed to Telegram, the application rechecks the owner watermark, settings revision, hours, idle period, age, and caps. Direct conversation has priority in the shared delivery loop.

Runs distinguish generating, prepared, sending, delivered, unknown, failed, silent, and suppressed. Only an actual Telegram receipt confirms delivery. Interrupted or ambiguous sends stay unknown and are never automatically replayed; they conservatively reserve pacing allowance. Definitive failures do not count as social messages. There are no automatic paid generation retries or repeated send attempts for a casual opportunity.

On restart, unsent in-flight work is suppressed, interrupted sends become unknown, and overdue opportunities are rescheduled. There is no catch-up burst. An opportunity that has become more than 15 minutes late is skipped rather than sent late. Changing settings reschedules future opportunities and suppresses unsent work, while preserving receipts from sends already underway.

Available late provider results are retained on the same fenced run after a pause/settings change, without restoring the message. Provider identifiers, usage and unavailable billed cost remain inspectable in private evidence; they are not inserted into immersive chat.

## Context and output

Core builds a bounded, immutable text snapshot without creating a fake owner message. It includes complete pinned core memory, bounded sleep-routine recall, the latest accepted owner statement with its actual date, optional 48-hour conversation evidence, and recent confirmed heartbeat texts. Only received owner text and receipt-confirmed assistant text enter the conversation evidence. Images are explicitly omitted.

Heartbeat inference keeps the selected Neuralwatt model, reasoning effort, and full saved completion allowance. A short visible message still needs room for the model's reasoning. This version exposes no executable tools during heartbeats; it cannot write memory, generate images, browse, or alter schedules.

The model returns a short native text message or the exact private marker \`[[HEARTBEAT_SILENT]]\`. The marker is never sent. Completion, message length, metadata-shaped output, and near-verbatim repetition are validated. Invalid, overlong, partial, or repeated output is recorded without sending. Messages are not chopped or rewritten after generation. Model silence is a successful outcome. This native format was selected after actual provider probes showed inconsistent adherence to a JSON wrapper.

Migration 012 indexes confirmed heartbeats as assistant evidence under their real run IDs. Later ordinary conversation context includes them in order, so an owner reply can refer to a prior heartbeat. Archive reads enforce owner/chat and temporal boundaries; heartbeat text cannot become an owner source for a memory save.

## Acceptance and limits

Deterministic checks cover persistence, randomized timestamps, all-day/overnight and DST boundaries, unanswered limits across restart, user-arrival and pause races, lease loss, immutable context and receipts, unknown-send recovery, source isolation, output bounds, and dashboard state.

Real-provider checks use fictional sources and voice. Production activation separately requires a verified private backup, controlled runtime restart, preserved existing data, owner prompt/settings revision, actual private dashboard checks, and recorded provider/delivery evidence.

Sleep interpretation, useful timing, tone, and semantic variety remain model judgments. This release implements casual companionship; scheduled reminders, reflection, and general interval jobs remain separate work.
