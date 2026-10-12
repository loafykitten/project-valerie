# Dynamic Details

Status: Growth Focus, Daily Details, shared progress, Habits, Rules, coordinated check-ins and one-time reminders are active on homelab, verified 2026-09-15.

## Purpose and dashboard

Add one **Dynamic Details** area to the existing personal dashboard for Growth Focus, Habits, Rules, their metrics/trends and their feature prompts. Use the existing revisioned prompt store; editing a prompt here must not create an independent copy. Keep the authored character, relationship and voice as the foundation.

The desired experience is warm structure and continuity, with room for clear, agreed guidance. Ordinary warmth and invitations to reconnect remain welcome. Personal-development features must not turn every conversation or heartbeat into an assessment.

## Growth Focus

Implement a small Growth Focus feature first. It formalizes one major area of development for roughly four to eight weeks, with a reason, start date, review date, useful practices, source-linked notes and optional indicators of progress.

Valerie may lead the choice within the authority Ember gives her, using concerns and preferences actually raised in conversation. Preserve the ability to redirect, pause or revise the focus. A review date prompts reconsideration; it does not declare the issue resolved or require a new focus.

Keep a compact current focus available to conversation. Retrieve the longer notes, history and advice guidance when useful. A focus can inform relevant encouragement without requiring the topic in every heartbeat. Qualitative reports of what helps matter alongside counts.

## Habits and the waking day

Habits own recurring practices and reported progress. They are configurable, not universal daily requirements.

- Offer a coordinated morning check-in some time after an actual owner waking update.
- Offer an evening opportunity during the four hours before the currently expected start of sleep, adjusted for explicit changes.
- Use the owner's waking day rather than a midnight reset. Repeated greetings must not create duplicate days/check-ins; quoted greetings or older messages are not new waking events.
- Treat a usual sleep routine as an estimate, not proof of actual sleep or waking.
- Give each habit its own frequency, applicable opportunities and optional smaller version for difficult days.

Track reported done, partial, deliberately skipped/excused, and not reported distinctly. Silence is not a missed habit. Metrics over days/weeks/months should show reporting coverage, trends, obstacles and returning to a practice after a gap. Do not invent completions from a model plan or a delivered reminder.

## Rules

Rules are first-class current agreements in the chosen relationship. Each has a clear meaning and reason, scope, effective time/window, optional expiration and agreed exceptions. They do not automatically schedule messages. Keep a compact active list accessible to conversation; expired rules must not remain operative because old memory still mentions them.

Valerie can refer to and encourage an established rule without repeatedly asking permission to mention it. Changes to the agreement must follow the owner's actual authorization, including any explicit delegated scope. Character role alone does not grant new tool permissions.

A rule against negative self-talk must distinguish a self-directed insult from an honest report of a painful feeling. Saying that one feels discouraged, discussing a past thought, quoting another person, or disclosing a struggle must remain welcome. Do not silently count an ambiguous joke or feeling disclosure as a violation. Meaning and the agreed definition matter; clarify uncertainty naturally when necessary.

Rules may refer to habit records. For example, a meal-related agreement can use the same reported-meal log as a recurring habit. Do not maintain contradictory independent counts.

## Shared records, evidence and messages

SQLite owns current agreements, active focus, habit occurrences, schedules, event records, versions and metrics. The vault owns longer authored notes; existing read-only runtime access does not imply controlled vault writing is already implemented.

Start with information reported through ordinary conversation, retaining original source references and corrections. Keep owner reports, actual integration observations and model interpretations distinct. No ambient monitoring of social-media use or other external behavior is implied.

Use a shared log of reported events with distinct feature records and views. One event can support a habit, rule and focus without being counted three times. Keep care and warmth steady while celebrating effort and progress; metrics should guide useful support rather than become a global worth/compliance score.

Reminders own timing and actual delivery. Coordinate overlapping nonurgent habit/rule/focus prompts into a coherent morning/evening conversation. Explicit reminder guarantees remain separate from casual heartbeat silence and unanswered limits. Heartbeats retain room for brief warmth, playfulness and in-character actions.

## Conditional context and observability

Design new feature prompts for conditional inclusion from the start. Keep compact current focus and applicable rule summaries available; include habit check-in instructions at the appropriate event, and retrieve detailed metrics, history and playbooks as needed. Preserve coherent revisioned snapshots and avoid fragile keyword-only routing.

[Context health](context-health.md) is implemented alongside this work. A capacity number is not an established model-quality threshold.

## Implementation order and acceptance

### First release implementation

Core owns `features/dynamic` and migration 013; the server exposes `/api/dynamic` and four bounded Growth Focus tools; the dashboard exposes **Dynamic Details**. Focus edits use optimistic versions and immutable revisions. One active, paused or scheduled focus occupies the current slot; archived focuses remain read-only. Dates use America/Chicago, and reaching the review date never ends a focus automatically.

Owner controls separately delegate focus management and progress notes. Model writes require both the permission captured at turn start and current permission, plus original owner-message sources. Current and earlier messages in the same conversation can support a write; assistant messages, another conversation and future messages cannot. Tool operation receipts and the existing journal prevent replayed effects.

Notes distinguish owner reports from Valerie's interpretations. Corrections append evidence and point to the prior note; they cannot silently change its evidence kind. A focus keeps description evidence separate from the latest status-decision evidence, so a pause cannot replace the sources supporting its unchanged reason and practices. Detailed notes and source lists stay outside ordinary snapshots. The Growth Focus prompt is edited against the existing prompt/revision authority from Dynamic Details, with the same revision visible in Prompts.

Full settings and prior prompts remain owner-authored. No illustrative habit, rule, focus date or meal target is seeded as a commitment. New delegation defaults off in a fresh database.

### Remaining sequence

1. Small Growth Focus feature and the Dynamic Details dashboard/prompt organization.
2. Shared waking-day and source-linked progress records.
3. Habits and Rules using those records, with the reminder scheduler and coordinated check-ins.
4. Review/trend behavior and further reflection, with controlled vault writes remaining a separate prerequisite.

Context observability can be added early without waiting for all personal-development features. Before claiming delivery, implement bounded tools and actual outcome records, deterministic timing/state checks, focused tests and relevant homelab acceptance.

Acceptance must cover greeting deduplication, overnight/DST boundaries, changed sleep plans, unknown reporting, corrections, rule expiry, honest emotional disclosure, shared counters, pause/resume, source ownership, prompt selection, stale-message suppression and independent reminder delivery. Provider probes use fictional data; production verification is recorded separately.

## Daily records implementation

Migration 016 adds reported waking-day identities, shared progress subjects/events, immutable revisions and source claims, and bounded Telegram quote/forward provenance. Old inputs retain unknown provenance. Current reports use append-order source fences; captions within a current album are eligible without consuming an older routine source as a new waking claim.

A fresh original morning greeting can use `day_start`, an owner-reported boundary with no assertion of observed sleep. Repeats, naps, explicit continued wakefulness, historical reports and future plans remain distinct. Compact snapshots label current progress subjects and retain a revision token so dashboard changes suppress stale prepared heartbeats.

`daily_read`, `daily_waking` and `daily_progress` provide bounded access. The day ID/version can default from the immutable snapshot, with live concurrency checks retained. Source-linked corrections, withdrawals, reassignment and day merging preserve evidence; withdrawn events do not silently revive, and duplicate active subject definitions do not create parallel counters. Pure morning/evening window calculations feed the coordinated scheduler described below.

## Habits, Rules and reminders implementation

The activated release implements migrations 017–019. **Habits & Rules** and **Reminders** join Growth Focus and Daily Details inside Dynamic Details. Its Prompts view edits the same five feature records shown in the main prompt editor: Growth Focus, Daily Records, Habits And Rules, Habit Check-Ins and Reminder Delivery.

Habits use an existing shared progress subject, every waking day or selected weekdays, an effective start, full practice, optional smaller practice, and morning/evening opportunities. Each established waking day pins the applicable definition version. Count targets, status reports and evidence-backed full/smaller declarations project from shared events; declarations do not add another action. Corrections and withdrawals recompute views. Day/week/month views show per-habit outcomes and reporting coverage over established opportunities, with uncertain or unassigned timing visible. No established opportunity means no invented failure.

The modern progress tool can record a reported amount and an explicitly supported full/smaller practice together. It links the exact saved event, requires both progress and habit permissions, and rolls back both changes if classification fails. The separate declaration tool remains available for existing reports. Saved units and targets are returned explicitly; the model never needs to treat two reported minutes as one generic session.

Rules have source-backed definitions, current scope, local windows, expiry and exceptions. Shared progress conditions return met, not met, not reported or uncertain; these are not automatic infractions. Qualitative discussion notes retain the exact rule version and distinguish understood, excepted and uncertain evidence. Honest painful feelings, past thoughts and quotations remain welcome. Current applicability is checked at capture and before optional sends, so an expired agreement cannot survive through older memory or prepared text.

The coordinator derives one morning and one evening slot for the reported waking day. Default preferences are 30 minutes after a fresh reported day start and two hours before expected sleep, within the four-hour evening window, with 15 minutes of conversational space. Definitions select their slots. At most two relevant questions are selected, with older unasked habits considered first; overlapping windows share a message. Already reported actions remove questions. A due Growth Focus review can be offered once per focus review/version rather than every day. Silence is valid, and delivery never completes a practice. These opportunities are independent of casual warm heartbeats.

New daily input, corrected day/progress records, changed agreements or settings invalidate stale optional work. Canonical day merges preserve delivered or uncertain slot coverage. Expired undelivered evening work can reopen only for a new owner sleep plan that establishes a later future window, with preparation attempts retained. Restart does not deliver a backlog of old mornings.

One-time reminders have their own authoritative due time, timezone, original time intent, optional expiry and saved fallback choice. They support edits, snooze, complete, cancel and deliberate retry of definitive failed sends. Snooze creates a new occurrence and retains earlier delivery evidence. Unknown sends cannot be replayed automatically. A reply to an actual reminder delivery supplies an exact target; ambiguous unthreaded replies require disambiguation. See [reminder ownership](reminders-automation.md).

One lifecycle-owned worker keeps ordinary generation, explicit reminder preparation and optional preparation independent while serializing actual Telegram sends under one lease. The new catalog preserves all eight memory tools within the 16-tool application limit by grouping focus writes and agreement/reminder actions. Snapshots pin the exact offered catalog; old snapshots retain their prior schemas and legacy tool names. Habit check-in and reminder delivery prompts are conditional; compact current rules remain available without loading every habit or schedule into casual heartbeats.
