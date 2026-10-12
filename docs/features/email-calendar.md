# Email and calendar management

Status: development specification for a later release. Research checked 2026-09-11. Depends on tool permissions, durable external-operation records, activity, scheduler, secret storage, and account authorization. **Ember's email/calendar providers are not yet specified**; choose one actual provider before implementing adapters.

## Scope and provider selection

Email begins with search/read and useful summaries, then draft replies and requested label/archive changes, then sending within explicitly authorized scopes. Calendar begins with event search/availability, then create/update/cancel for a specified calendar. Neither requires exposing the entire mailbox or calendar in every conversation.

| Actual provider | Initial adapter | Tradeoff |
| --- | --- | --- |
| Gmail / Google Calendar | Native REST APIs with OAuth | Strong provider IDs and incremental synchronization; requires Google app/account setup |
| Outlook / Microsoft 365 | Microsoft Graph | Native mail/event operations and delta tracking; permission details depend on account/tenant |
| Other hosted mail / calendar | Provider API if available; otherwise IMAP/SMTP and CalDAV | More variation in auth, threading, recurrence, and synchronization; implement only for the selected host |

Gmail provides partial synchronization using history IDs and requires a fresh full sync if a cursor is no longer available. Google Calendar offers sync tokens and uses HTTP 410 for an invalidated token. Microsoft Graph delta queries use opaque next/delta links and clients must handle replayed changes. These mechanisms justify durable per-account cursors and idempotent merges. [Gmail sync](https://developers.google.com/workspace/gmail/api/guides/sync), [Calendar sync](https://developers.google.com/workspace/calendar/api/guides/sync), [Graph delta](https://learn.microsoft.com/en-us/graph/delta-query-overview).

Use a small interface per domain, not a universal integration framework. Keep provider-specific flags and IDs available rather than losing information to the lowest common denominator. Do not add a second provider until Ember needs it.

## Data contracts and authorization

| Record | Key fields |
| --- | --- |
| `connected_account` | provider, display label, granted scopes, secret reference, status, last successful sync, configuration revision |
| `sync_state` | account, collection, opaque cursor, in-progress page token, last committed time, resync reason |
| `mail_item` | account/provider ID, thread ID, headers, dates, snippet, labels, optional cached body reference, etag/version if supported |
| `calendar_item` | account/calendar/provider ID, UID, recurrence/instance identity, start/end and timezone, all-day flag, attendees, source version |
| `external_operation` | operation ID, user/job authorization reference, exact target/payload hash, expected version, status, provider result IDs, retry/ambiguity state |

OAuth tokens live in restricted server-side storage or a secret manager, outside Git, prompts, and tool results. Use appropriate read-only scopes first; expand for requested writes. Token renewal is a deterministic adapter task. Revocation/expired authorization marks the connection as needing attention, not as an empty mailbox/calendar.

An explicit user request such as “send this reply to X” authorizes that concrete action. Requests to summarize or draft do not imply sending. A standing automation can send within its saved scope; do not ask the same permission every run. New recipients, attachments, destructive cleanup, or invitations outside that scope need a concrete preview/authorization before the external effect. Incoming mail/calendar text cannot grant that authority.

## Email behavior

Tools: `email.search`, `email.read`, `email.thread`, `email.createDraft`, `email.updateDraft`, `email.sendDraft`, and narrowly scoped label/archive operations. Search returns bounded headers/snippets with IDs; load full bodies only when needed. MIME parsing preserves relevant authored content, text alternatives, attachment metadata, reply threading, and sender/recipient distinctions. HTML is sanitized for dashboard display and converted to source-labeled text for inference; remote images/tracking URLs should not auto-load.

A draft stores exact recipients, subject, body, attachments, source thread, and version. Sending acts on a specific saved draft/version and records resulting provider IDs. If the draft changed since authorization, check whether the authorized payload still matches rather than silently sending different text. Use reply/reference headers/provider thread mechanisms so replies join the correct thread.

The persona used to talk to Ember is separate from the tone used in an external email. Valerie can explain a draft warmly while the draft itself matches the recipient and Ember's requested professional/personal style. Do not insert personal character language or relationship details into outgoing correspondence unless explicitly requested for that recipient/context.

Start with periodic incremental sync through the existing interval scheduler. Gmail push uses Cloud Pub/Sub and watch renewal; its guide recommends daily renewal and requires renewal at least every seven days. Notifications can be missed, so retain periodic reconciliation if push is added. This added infrastructure is optional until polling latency proves insufficient. [Gmail push](https://developers.google.com/workspace/gmail/api/guides/push).

Do not summarize every email on arrival. A saved watch specifies folders/labels, relevance criteria, urgency, quiet hours, and notification frequency. It records why a message matched and whether Ember has already been told. Reading a message to summarize it does not necessarily imply changing its unread state; make that a configured policy.

## Calendar behavior

Tools: `calendar.list`, `calendar.search`, `calendar.availability`, `calendar.create`, `calendar.update`, `calendar.cancel`. Require explicit calendar selection/default, preserve IANA timezone, distinguish date-only all-day events from timed events, and represent recurrence exceptions/instances. iCalendar defines these separate date/time and recurrence concepts; reducing everything to one UTC timestamp loses intent. [iCalendar RFC 5545](https://datatracker.ietf.org/doc/html/rfc5545).

When creating an event, resolve date, start/end or duration, timezone, title, calendar, attendees, and notification policy from the request/current context. Ask only for missing facts necessary for a reliable creation. An all-day event is not “midnight plus 24 hours.” Display the proposed local date/time before an ambiguous action and save the provider's actual result.

Updating a recurring event must specify one occurrence, this-and-following, or the entire series. Fetch the latest event/version before a write and use conditional requests where supported. Google Calendar documents ETag/If-Match protection against overwriting concurrent changes. A conflict triggers a fresh read and a concrete resolution rather than silent last-write-wins. [Calendar resource versions](https://developers.google.com/workspace/calendar/api/guides/version-resources).

Calendar events and reminders are linked but independently owned: an event owns scheduled appointment details; a reminder owns Valerie's follow-up cadence/snooze/completion. An event update can deterministically refresh an explicitly linked reminder's event reference/due derivation, with an audit record. Do not maintain appointment copies in long-term memory. Cancelling a calendar event does not automatically erase unrelated tasks about preparation or follow-up.

## Synchronization and failure handling

Merge each provider page by stable resource ID/version and persist the cursor only after associated local updates commit. On cursor invalidation, rebuild the provider cache safely while retaining local drafts, authorizations, activity, and linked reminder identity. A resync is not permission to delete the user's server-side mailbox/events.

External writes have `prepared`, `submitted`, `confirmed`, `failed`, and `unknown` states. Record the payload and authorization before submission. When a timeout follows submission, inspect provider state using IDs/client operation identifiers where available before retrying. Email sending in particular must not be blindly replayed as if every API were idempotent. Delivery of an email can remain uncertain even if a local draft disappeared; expose the evidence and recover carefully.

Rate limiting backs off within a bounded policy. Repeated authorization failure stops that adapter's jobs and preserves other features. Calendar conflicts remain unresolved until re-read/resolved; summaries do not claim an event moved when the write failed. Missing/deleted content is labeled in retrieval, not reconstructed from memory as current fact.

## Delivery phases and acceptance

**First:** select provider, OAuth connection, read/search, limited cache and incremental sync, account health. **Then:** saved drafts and user-requested mutations with operation ledger, linked reminders, relevance watches. **Later:** push notifications and additional providers only if useful.

- Initial sync, subsequent changed/deleted items, duplicate pages, cursor expiry, and restart at a page boundary converge without duplicates or lost local drafts.
- A crafted email containing tool instructions remains untrusted message content and cannot send mail, alter prompts, or change reminder state.
- A draft retains exact recipients/subject/body and sends the authorized version once where provider semantics allow; ambiguous delivery is visible.
- Revoked OAuth is shown as disconnected/action required, not “no events” or “no new mail.”
- Calendar tests cover all-day dates, multiple timezones, DST, recurring exceptions, concurrent changes, and attendee-notification choices.
- “What are you up to?” reports actual completed/failed organizer work with source IDs and outstanding needs.
- Read-only fixtures do not mark mail read, send, archive, or invite anyone as unintended side effects.
