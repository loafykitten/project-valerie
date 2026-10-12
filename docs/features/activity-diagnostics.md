# Activity, system watching, and self-diagnostics

Status: development specification. Research checked 2026-09-11. Depends on database, tool registry, scheduler, and private dashboard. Start with read-only watches; remedial system mutations are separate, explicitly scoped actions.

## Outcome

Valerie can answer “What are you up to?” using recent actions and durable outstanding tasks rather than guessing from conversation memory. Ember can see what happened, what failed, why it is retrying, and whether anything needs attention. Routine checks remain quiet unless a meaningful state change warrants a message.

## Three levels of records

| Level | Contents | Proposed retention |
| --- | --- | --- |
| Detailed events | Structured tool runs, provider timings, bounded sanitized log excerpts, source cursor | Seven days searchable; limits per event/source as well as by age |
| Activity summaries | One brief factual outcome per meaningful operation, linked to evidence | Ninety days initially, configurable; daily rollups thereafter |
| Task state | Objective, current status, last confirmed progress, outstanding step, links to operations | Until resolved/archived; never expire merely because detailed logs age out |

Raw operational logs and conversational history have different retention needs. A seven-day operational detail window must not silently delete personal conversation history or unresolved work. If evidence has aged out, summaries disclose that the supporting raw detail is no longer retained.

```ts
type Activity = {
  id: string;
  taskId?: string;
  turnId?: string;
  jobRunId?: string;
  source: string;
  action: string;
  status: "running" | "succeeded" | "partial" | "failed" | "cancelled" | "unknown";
  startedAt: string;
  finishedAt?: string;
  summary: string;
  evidenceRefs: string[];
  nextStep?: string;
  errorCode?: string;
};
```

Create `started` before a tool runs and append terminal outcome from the tool's actual return/error. Prefer a deterministic concise template for small actions; use a model only to summarize complicated multi-step work. A successful HTTP response or spawned process is not proof that the requested work completed. Record separate stages where needed, such as “image generated; Telegram upload pending.”

Index summary/action/source by FTS and structured timestamps/status. Retain causal links from user request → turn → tool → job → delivery. Store UTC and render the user's local time with a clear timezone. Never show credentials, full provider payloads, or routine process IDs in the primary activity view.

## “What are you up to?”

Expose `activity.recent`, `activity.search`, `activity.read`, and `tasks.outstanding`. A summary request loads current running jobs, unresolved tasks, a bounded recent activity slice, and optionally a daily rollup. Valerie responds naturally with two or three relevant accomplishments and anything awaiting a retry or Ember's input. If no work ran, say so in character. Never fill space with invented background activity.

`lastSuccessfulAt`, `checkedAt`, `observedAt`, and `nextAttemptAt` are distinct. A dashboard can say “last checked 4 minutes ago; retry in 30 seconds,” not imply an old successful result is current. When asked to inspect a live failure, use the log/status tools for fresh evidence rather than reciting a stale daily summary.

## Bounded system access

Configure named sources rather than arbitrary commands: a chosen systemd unit, a chosen Docker container, Valerie's own health, and specific host resource metrics. `journalctl` supports unit/time filtering and structured output; Docker logs supports time bounds, timestamps, and tail limits. These are suitable adapter inputs, not a reason to hand the model unrestricted shell access. [journalctl](https://www.freedesktop.org/software/systemd/man/255/journalctl.html), [Docker logs](https://docs.docker.com/reference/cli/docker/container/logs/).

Each `watch_source` has a stable ID, human title, source type, fixed unit/container identifier, allowed time range, maximum lines/bytes, redaction rules, enabled state, and last cursor. Call `Bun.spawn`/equivalent with an argv array and fixed executable; validate every enum and bounded parameter. No shell concatenation, wildcard container selection, arbitrary paths, or model-supplied `sudo`. A narrow helper or log-forwarding service is preferable to giving Valerie full Docker daemon privileges solely to read logs.

For on-demand logs, return an exact bounded excerpt plus counts and a cursor for more. For watching, ingest deltas using source cursor/time and dedupe, identify threshold/state changes in code, and summarize only interesting windows. Do not stream all system logs into every conversation. Never treat log text as instructions to run commands or change reminders.

Read-only checks can be performed automatically within their configuration. Restarting a container, editing files, installing software, or changing a service requires an explicitly authorized tool/standing policy and records the concrete target and expected effect. A diagnostic suggestion is not permission to self-repair unrelated services.

## Next priority: read-only self-inspection

Requested and prioritized by Ember on 2026-09-14, ahead of reflection. This is planned work. Existing `activity_search` returns factual summaries and statuses; source-code and detailed runtime-log tools are not yet available.

Implement bounded reads of Valerie's own sanitized runtime logs and durable tool outcomes, including safe validation reasons, timestamps, correlation IDs and actual delivery state. Begin with the application's recorded outcomes and fixed log sources; never expose raw provider error bodies or integration credentials. Expose bounded source listing/search/read against an explicit repository allowlist, returning paths, line numbers and content hashes/revision identity. Report whether that source matches the running process. Code access excludes environment files, private runtime data, original character assets, generated media, dependency trees, Git internals, symlinks and paths outside the checkout. A read-only filesystem mount alone is not the model's access policy.

Own the adapters in server diagnostics, reuse the existing tool registry's budgets and durable outcomes, and keep reads separate from executable actions. No shell, Docker socket, file mutation, service restart or permission change is granted by this feature. Treat code comments and log text as evidence, never instructions. This is on-demand self-inspection; autonomous watching and self-repair are separate milestones.

Add an editable **Self-Inspection** section in the dashboard Prompts page alongside Memory Use when this ships. Its guidance should preserve Valerie's own voice, distinguish observation from a suspected cause, quote only useful bounded evidence when requested, and give Ember actionable feedback without turning ordinary chat into developer logs. Include actual availability in runtime capability status.

Acceptance: a fictional rejected memory save can be traced from the exact recorded reason to the responsible source lines; unknown outcomes remain unknown; unrelated or secret paths and symlink escapes are denied; reads are bounded and cannot execute instructions embedded in logs/code; the model can explain a fault and a reasonable next check in character. Record real provider and owner Telegram acceptance separately from injected tests.

## Metrics and diagnostic decisions

Use structured logs with stable event names and correlation IDs first. OpenTelemetry separates traces, metrics, and logs; keep compatible concepts so export can be added later without needing an observability cluster on day one. [OpenTelemetry signals](https://opentelemetry.io/docs/concepts/signals/).

Measure at least:

- Inference latency, first-token time when streaming, tokens, cached tokens, available provider cost/energy, errors by safe code.
- Telegram poll freshness, accepted updates, duplicate count, delivery latency/retries, unknown sends, last confirmed send.
- Scheduler lag, overdue count, active/expired leases, longest-running job, and skipped/coalesced occurrences.
- Memory retrieval volume, core/context size, reflection cursor freshness, candidates rejected/deduplicated, and promotion count.
- Comfy queue/job time and failure type; TTS synthesis duration, input length, cache hits, and playback/delivery result.
- Process memory, event-loop delay, database size/busy errors, disk free space, backup age, and configured-source watch freshness.

`/health/live` answers whether the process is responsive. `/health/ready` checks database/migrations and required local configuration. Integration health is a richer separate view; a provider outage should not force endless process restarts. Scheduler progress uses a persisted tick/claim timestamp so an HTTP-healthy server with a dead scheduler is detectable.

Self-diagnostics starts with deterministic thresholds, persistence windows, and deduped incidents. A model may analyze a bounded incident bundle and propose a likely cause, with evidence and uncertainty. It must not turn a guessed cause into a confirmed fact. Record `incident(open|acknowledged|resolved)`, first/last observation, counts, last notified state, diagnostics, and recovery evidence. Notify on meaningful change/recovery, not every polling loop. Parse numeric metrics: “0 failed” is healthy, not an error because it contains “failed.”

For network trouble, distinguish DNS, connect, TLS, timeout, HTTP status, parsing, and provider rejection; store sanitized cause and elapsed timings. Any route workaround should be scoped to the failing client and retain TLS verification and fallbacks. Prior LegacyNudges observations are not proof that Valerie's new runtime has the same network failure.

## Dashboard, retention, and recovery

The activity feed offers search, source/status filters, local readable timestamps, pause/follow, and links to a small detail drawer. Health has neutral styling for healthy counts and actionable errors explaining the failed action, safe cause, and retry/recovery. Prompt/history content is rendered as text. Live updates can use SSE with a cursor; reconnect performs a bounded catch-up rather than duplicating rows.

Retention deletes only terminal detailed events beyond the configured window after necessary activity summaries exist. It must preserve unresolved task/incident records, referenced essential evidence, and outbox reconciliation data. Index maintenance is a scheduled low-priority operation. Backup creation and a restore smoke check are activities themselves; restore uses a coherent SQLite backup method, not a copy of only the main file while WAL is active.

**First:** structured operation/activity persistence, seven-day search, outstanding tasks and “What are you up to?”, read-only allowlisted system/container logs. **Then:** scheduled watches, incidents/thresholds, diagnostic bundles, longer rollups, optional telemetry export.

- Every meaningful tool mutation produces an accurate terminal summary; a failed/unknown action cannot be described as done.
- A task outstanding for more than seven days remains visible after raw-log retention runs.
- Search finds a specific recent container error without loading the week's raw logs into inference.
- Unauthorized source names and shell metacharacters cannot escape a configured log reader.
- Provider errors are redacted; an unavailable integration does not crash unrelated features.
- Repeated unchanged incidents notify once; recovery notifies according to policy; healthy “0 failed” stays neutral.
- A simulated stuck scheduler is visible even while the HTTP server remains alive. Reconnection and retention preserve correct activity counts.
