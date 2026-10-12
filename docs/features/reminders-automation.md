# Reminders, interval jobs, and casual heartbeats

Status: one-time reminders and coordinated check-ins are active, verified 2026-09-15; recurrence, repeat nudges and interval jobs below remain design scope. Original research checked 2026-09-11. Depends on durable storage, authoritative local time/timezone, inbox/outbox, and activity. Natural language helps create/describe jobs; deterministic code owns timing and state transitions.

Ordering updated 2026-09-15: Ember brought [casual heartbeats](heartbeats.md) forward, ahead of reminder implementation. The broader recurring reminder/interval design below remains planned; the bounded one-time implementation is described first. The heartbeat feature has its own current scope, including any-hour delivery, brief warmth and actions, and owner-configured pacing.

## Current conversational timing

The September 15 follow-up moves reminder-time arithmetic into the versioned write tool. New turns use one of `relativeMinutes`, an offset-free `localDateTime`, or `dayOffset` plus `localTime`. Relative/today/tomorrow requests anchor to an original owner message in the current turn, so a delayed response cannot restart the timer or silently move tomorrow across midnight. The default new-reminder zone is America/Chicago; existing reminders retain their zone unless explicitly edited.

The local resolver chooses the first occurrence of a repeated hour unless the second is requested, and the first valid minute after a nonexistent time. The result retains the requested local input and reports adjustments. Write confirmations and read results include the actual saved local time; the model should use it directly. Metadata edits may omit timing and expiry to preserve them; expiry removal is explicit. Pinned older tool catalogs keep their existing UTC contracts. Owner API/dashboard records and scheduling remain UTC-backed.

## Three separate responsibilities

The September 15 implementation is bounded to one-time reminders and coordinated waking-day check-ins. The broader recurrence, interval-job and repeat-nudge design below remains future scope.

- SQLite owns logical reminders, schedule versions, immutable occurrences, preparation results and actual Telegram attempt receipts. Due explicit reminders take turns with ready direct replies and images, independently of slow conversational inference, heartbeat caps and optional silence.
- Reminder preparation begins at most a minute before its saved due time. If the saved fallback option permits it, a simple title-based notice can be prepared at the due time or after generation failure; otherwise preparation failure is reported. A successful send leaves the task active until an actual completion decision.
- Cancellation and snooze suppress unsent work. An already started send can still arrive; its receipt remains factual and cannot reactivate the parent. A late known positive receipt updates evidence for the original attempt without dispatching again. Unknown sends stay unknown until such evidence or a distinct owner action exists.
- Check-ins have a separate enabled setting and morning/evening preferences. Shared slots, source/version checks, bounded preparation attempts and confirmed question coverage prevent duplicate or stale optional messages. They may return silence. A missed optional opportunity is not a missed habit.
- Confirmed reminders and check-ins enter conversation and search history as assistant evidence. Their delivery does not establish reading, waking, action completion or permission. Scheduled generation has no executable tools and keeps its single-call provider usage in the occurrence journal; the existing context-health request ledger covers ordinary conversation and heartbeats.
- **Dynamic Details → Reminders** exposes definitions, current occurrence, exact due/actual delivery times, fallback usage, failures and uncertainty. Definitive failures have an explicit retry action; uncertain sends do not. Local timing and durable state cannot guarantee exact Telegram/network arrival.

| System | Purpose | Initiation and result |
| --- | --- | --- |
| Reminder | Help Ember follow through on a particular task/event | Fires on its saved schedule until completed/cancelled/expired or explicitly snoozed/paused under its policy. |
| Interval job | Perform recurring work, such as checking news or running an approved script | A persisted occurrence executes a defined payload and records a result; notify only according to that job's policy. |
| Heartbeat | Offer spontaneous companionship | A contextual opportunity to talk or stay quiet, independent from reminder execution. |

OpenClaw's scheduler demonstrates a durable job/run model separate from language-model execution. Valerie uses that general separation but deliberately does not route reminder delivery through casual heartbeat gates: reminders remain timed unless Ember explicitly snoozes or changes them. [OpenClaw automation](https://docs.openclaw.ai/cron-jobs).

A heartbeat is primarily conversation. It must not become an extra reminder disguised as warmth, an unsolicited productivity check, or “have you done it yet?” A natural conversation about the same subject is allowed when it adds no task prompt. Silence is an ordinary successful outcome.

## Reminder contract and lifecycle

```ts
type Reminder = {
  id: string;
  title: string;
  purpose: string;
  details: string;
  timezone: string;
  schedule: ScheduleSpec;
  nextOccurrenceAt?: string;
  status: "active" | "paused" | "completed" | "cancelled" | "expired";
  snoozedUntil?: string;
  repeatNudgePolicy?: { everyMinutes: number; maxAttempts?: number; until?: string };
  expiresAt?: string;
  quietHoursPolicy: "respect" | "allow";
  createdFromMessageId: string;
  revision: number;
};
```

Keep recurring occurrence state separate from the parent reminder. A daily reminder can have today's occurrence complete while tomorrow's remains scheduled. Completing one occurrence is not deleting the recurrence. A snooze defers an occurrence or explicitly selected scope; it must not silently move every future recurrence. The tools return a human-readable schedule and the exact next due time with timezone.

Occurrence lifecycle: `scheduled → claimed → preparing → queued → delivered`; retryable/unknown/failed delivery states remain visible, and a user can complete/cancel an occurrence during any pre-delivery state. An occurrence has `(reminderId, scheduledFor, scheduleRevision)` uniqueness, scheduled time, lease, due/lateness information, delivery IDs, attempt count, completion evidence, and terminal outcome. Recheck current reminder revision/status immediately before enqueue/send to handle last-second cancellation or snooze.

Purpose and details can include task context, appointment logistics, contact details, and follow-up rules. These stay in the authoritative reminder record, not duplicated in short/long memory. A link from memory/history is fine. “Done” is resolved against a recent delivered reminder or clearly identified task; with multiple plausible tasks, clarify without mutating any of them. LLM inference is never the only signal that a reminder was completed.

## Clock, recurrence, and durable scheduling

Store absolute timestamps as UTC plus IANA timezone and the user's original calendar intent. Use timezone-aware calendar arithmetic for “every day at 8 AM”; `24 * 60 * 60` seconds is a different schedule across daylight-saving transitions. Display dates in Ember's configured local zone (initially America/Chicago). Define and test nonexistent-time and repeated-time policy: suggested default move a skipped local time to the first valid time that day, and fire once at the first occurrence of a repeated local time. Make this visible when creating such a schedule.

Persist `nextRunAt`, schedule specification, enabled state, missed-run policy, and job version. A short scheduler tick claims due jobs transactionally with a lease and creates a unique occurrence. A timer is a wake-up optimization; it is not the source of truth. On restart, reclaim expired leases and reconcile queued/delivered work before scheduling more.

Do not hold a SQLite transaction during generation or delivery. Use lease renewal for bounded long work, expiration for crashed workers, and a monotonically increasing claim/fencing version so a late old worker cannot commit after replacement. One scheduler process is adequate initially; the data model must still withstand crash/restart races.

Differentiate schedule retries from notification repetition. A transient failed send retries the same delivery; a configured “remind every 20 minutes until done” creates later nudge occurrences. A successful delivery does not complete the underlying task. Defaults should limit notification storms after downtime: coalesce overdue nudges into one useful reminder or expire them under the specific reminder policy, while recording skipped occurrences. Do not invent a universal catch-up behavior for missed medication, appointments, and ordinary chores; prompt for meaningful semantics when creating such a reminder.

## Interval work and programmatic triggers

`scheduled_job` holds name/purpose, kind (`agent_task`, `script`, `reflection`, `watch_check`), schedule, timezone, enabled state, payload revision, resource/permission scope, overlap policy, deadline, retry policy, missed-run policy, notification policy, and next run. `job_run` records one occurrence, input cursor, result summary/evidence, next cursor, and outcome. Configuration edits apply at the next unclaimed occurrence; running work retains its captured version unless explicitly cancelled.

News jobs save topics, approved source/tool, a since cursor, and dedupe keys for discovered items. New coverage is compared with prior items before delivery; “nothing new” stays quiet. Reports preserve source URLs and publication/event dates. Script jobs select a registered command ID with typed arguments, fixed working directory, timeout/output limits, and permissions. Models cannot supply arbitrary shell text. Output is treated as data and summarized into activity.

Event triggers use a typed rule, such as `activity.failed` for a named job or `watch.threshold_crossed` for a configured source. Rules have enabled state, debounce, cooldown, dedupe key, and maximum firings per window. A trigger can enqueue a job or reminder occurrence, not recursively invoke itself without limits. Trigger creation/change is auditable and within the user's requested scope.

## Heartbeat gate and pacing

Before spending inference, deterministic checks assess enabled/quiet hours, explicit sleep/space preferences, minimum spacing, pending direct user turn, last genuine user message, and unanswered delivered heartbeat count. Suggested starting policy: after two delivered heartbeats without a new user message, suppress further casual heartbeats until the user speaks. The count comes from the durable delivered-message archive, so restart, midnight, and context trimming cannot reset it. Delivery failures do not count as a social message.

A configurable interval/jitter offers opportunities (for example 45–90 minutes during eligible hours), not a promise to send every interval. The heartbeat prompt sees a compact current-context digest and recent heartbeat texts, can return structured `speak` or `silent`, and is limited to read-only conversational context tools. It may not snooze, complete, reschedule, or create reminders because the user did not reply. Repetition checks and a second send-time gate prevent stale output after a user message arrives while a heartbeat is generating.

Do not load every outstanding task into the heartbeat as a coaching checklist. Due reminder delivery remains independent of all heartbeat suppression/quiet heuristics unless the reminder's own explicit quiet-hours policy says otherwise. Where quiet hours might affect a requested reminder, resolve that at creation time rather than silently changing it later.

## Failure behavior, dashboard, and acceptance

Dashboard shows active/completed reminders, next due, timezone, snooze countdown, purpose/details, latest delivered attempt, and missed/failed/unknown outcomes. Interval jobs show last/next run, duration, notification policy, and bounded logs. Heartbeat controls show eligibility and a plain reason when suppressed, without turning silence into an error.

Model outage should not erase due work. A reminder may use a configured simple fallback containing its authoritative title/due context when generation fails; log that fallback. A missing script, permission failure, or persistent provider auth error marks that job as needing attention with finite retries. Scheduler health is measured independently from HTTP health.

**First:** one-time reminders, explicit snooze/complete/cancel, persistence/restart, delivery reconciliation. **Then:** recurrence/nudge policy, interval scripts/news, reflection schedule, conversational heartbeat gates, configurable event triggers.

- Restart immediately before/after claim, enqueue, and confirmed send: one local occurrence and correct recovery; ambiguous external delivery is exposed.
- Snooze/cancel while generation runs prevents stale delivery. “Done” completes only the intended occurrence/reminder.
- Daily local-time recurrence passes spring-forward/fall-back tests; changing timezone has explicit, tested semantics.
- Two unanswered casual messages suppress later heartbeats across restart and midnight; a new user message reopens eligibility. Timed reminders still deliver.
- Reflection/heartbeat cannot write reminder state or duplicate reminder logistics into memory.
- Overdue runs obey each job's catch-up policy; no startup burst of every missed casual check.
- Trigger loops, overlapping script runs, and repeated unchanged news are bounded/deduplicated, with accurate activity outcomes.
