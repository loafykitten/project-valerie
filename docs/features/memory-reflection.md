# Memory, retrieval map, and daily reflection

Status: first retrieval and tool implementation. Reflection and controlled vault writes remain development specifications. Research checked 2026-09-11. Proposed later size/retention values are adjustable starting points, not universal model limits.

Storage decision updated 2026-09-14: use the Obsidian vault for authored source notes, curated long-term prose, and topic links. [Encrypted headless synchronization and the vault guidance review](obsidian-sync.md) are delivered. SQLite retains independent core/short memory and original conversation evidence; memory is not limited to the vault.

## First implementation

Owners: core memory owns records, revisions, FTS5, source evidence, settings and turn selection; server memory owns read-only vault access, lifecycle and private HTTP routes; server tools owns bounded execution and durable outcomes; the dashboard Memory page owns inspection and owner edits.

- **Core and short memory:** explicit owner saves, edits, core pinning, archival, revision reads, optimistic conflicts and exact duplicate prevention. Model saves can synthesize current or earlier owner messages in their own words, with a separate optional thoughts field and original source references. Active short-term notes can be updated with an expected version; core and vault edits remain unavailable to the model. Short notes default to 30 days; expiry archives the record and preserves evidence. **Prompts → Memory Use** holds the editable behavioral guidance.
- **Vault:** startup reconciliation completes before conversation work starts, followed by serialized 30-second scans. Only approved roots are indexed; Archive requires an explicit historical search. Exact note bytes/hash and each indexed revision are retained. Missing, inaccessible, replaced or excluded sources stop new recall while original revisions remain stored. The API mount is read-only and contains no sync credentials.
- **Boundaries:** Linux directory descriptors pin every ancestor; symlinks, hardlinks, hidden/private/config/backup/conflict entries and nonregular files are excluded. Limits are 2,000 notes, 128 KiB per note, 16 MiB text per scan, 20,000 entries and depth 16. Other platforms fail closed for vault scanning. Core memory and conversation search work without a vault.
- **Recall:** FTS5 uses normalized lexical terms, weights title matches above body matches, then orders ties by freshness and stable ID. Snippets show matching context. Approved wiki/Markdown links and explicit topic memberships support bounded one-hop related lookup; topic notes are pageable. There is no embedding model or graph database.
- **Turn snapshots:** selected revisions and excerpts, settings, current local time and conversation history are pinned together. Defaults reserve 1,500 conservative tokens for core, 2,000 for relevant memory and 750 for topics; owner settings permit 0–32,000 each, subject to the whole context budget. Each UTF-8 byte counts as a token. Core records are never silently truncated or displaced; oversized edits/settings are rejected. Retries retain the original snapshot.
- **Tools:** `memory_search`, `memory_read`, `memory_related`, `topics_list`, `conversation_search`, `memory_save`, and `activity_search` run beside the existing image tool. Revision reads are paged. The archive includes every original owner input and only receipt-confirmed assistant deliveries; activity lookup retains its seven-day detail window and all-age outstanding records. Tool rounds/results are journaled; synchronous SQLite writes and their outcomes commit atomically. See [inference tools](inference-tools.md).
- **Inspection:** Memory opens to a compact readiness summary, saved memories, and topic shortcuts rather than the full note index. One search spans saved records, notes, and older conversations, with eight concise memory/note results per page and explicit archive inclusion. Focused/Balanced/Roomy recall styles explain the normal choice; exact context limits remain collapsed under Advanced. Adding, reading, editing, restoring, history, source status, and recent-use details each have a focused view. Note previews remove Markdown plumbing while the exact source revision remains available in the reading view. Editing vault prose remains in Obsidian. Archive retains data; it is not a privacy-erasure operation.

Automatic extraction/reflection, long-term file writes and their recovery journal, forgetting/source erasure, review/promotion queues, configurable expiry UI, hierarchical graph traversal, embeddings and an index-rebuild control remain planned. Semantic separation of quoted reminder logistics is instructed, not guaranteed by a keyword classifier; memory never executes or owns reminder schedules/status. Retrieved prose cannot grant tool permissions. Saved character/Ember Knowledge prompt prose remains separate and unchanged.

## Conversation summaries and thoughts

The save tool accepts a useful title, a factual summary in `body`, optional tentative observations in `thoughts`, and real owner `sourceIds`. There is no verbatim-body or current-message-only restriction. `conversation_search` can retrieve older messages outside the 48-hour recent context window; `conversation_read` pages the original text. Tool reads are restricted to the same conversation/owner and the current or earlier turn. Saves accept owner input IDs, not assistant deliveries, other conversations, another sender, or future queued turns. Stored source excerpts are taken from the original messages by the application, independently of the model's summary.

Valerie can update an active short-term record by reading its current version and submitting `id` plus `expectedVersion`. The update and receipt commit atomically, and retries reuse the committed operation. A stale version is rejected with an actionable reason. Core and vault records cannot be changed by this tool. Source links carry forward up to ten current links, prioritizing the newly cited messages; omitted earlier links remain in prior revisions and are identified in the UI. Owner edits keep room for their own provenance so a full source list cannot prevent editing. Every prior version remains available. Existing memories are not automatically rewritten when this feature is activated.

The summary and thoughts have separate storage, rendering and context labels. Thoughts are searchable but remain tentative interpretation rather than owner facts or permissions. The dashboard identifies core, short-term and long-term Obsidian memory, filters saved records by tier, shows thoughts separately and can open the exact original source message. Core is always-present owner-pinned context; short-term notes normally last 30 days; long-term authored notes are currently the read-only Obsidian vault.

Code validates source identity/ownership, version/state boundaries, size limits and transactions. It does not claim to prove the semantic correctness of a paraphrase. The editable Memory Use instructions require supported facts, distinct tentative thoughts and respect for current corrections. Migration 010 rebuilds only the FTS index to include thoughts and preserves all original records/revisions. Acceptance covers historical recall and synthesis, separate interpretation, revision updates and rollback, source isolation, explicit UI tiers and private evidence reads.

The 2026-09-15 memory quality update uses up to 64 bounded lexical cues across the whole incoming message for automatic recall, filtering common English conversational filler. Explicit search retains literal keyword lookup, and `memory_search` accepts an empty query for broad browsing. Automatic retrieval never falls back to browsing and retains the existing archive/availability and budget controls. Relevance remains heuristic; creative notes remain eligible when their words match.

Memory Use revision 3 instructs Valerie to link every owner message supporting a combined summary, including original details and later updates. Personal experiences and preferences belong in the body with their personal scope preserved; only her added interpretations belong in thoughts. It asks for natural acknowledgements without permanence claims and accurate tier/expiry explanations when asked, preserving her authored voice. Existing authored memory prose is preserved; one source-only maintenance repair is recorded with a retained prior revision.

## Folder browsing in the dashboard

The Notes tab starts in the vault's `Notes` collection and lists immediate subfolders with descendant note counts. It lists only notes directly in the selected folder, ordered by title and paged eight at a time. Nested folders remain separate collections. Breadcrumbs reach the parent or all collections, including topic guides and (when explicitly enabled) Archive. The overview shortcuts open these same folders. Search within Notes covers the selected folder and descendants; the Everything search remains cross-source. Returning from a note preserves the folder and page, while changing folder, query, source or archive mode resets pagination.

Core `browseNotes` and `GET /api/memory/notes` read only current available vault index entries. Folder prefixes use literal segment boundaries, including literal `%` and `_` characters. Counts and pages are selected in one SQLite transaction; stale cursors offer a refresh. No file is moved or rewritten, and no permission or schema change is required. Empty/unavailable folders do not expose retained historical note bodies. The browser includes only indexed folders, so folders containing no eligible notes are absent. The metadata scan has a 10,000-entry guard.

## Outcome and boundaries

Valerie remembers personal context, stable preferences, shared experiences, and useful learned knowledge without injecting the entire history into every reply. She can follow a topic into progressively deeper detail and explain where a remembered fact came from. Reflection can consolidate knowledge and propose improvements, while preserving Ember's authored character and preventing yesterday's summary from overriding today's facts.

Memory is not the scheduler, task database, or log archive. Reminder purpose, logistics, dates, cadence, status, and snooze belong to the reminder record; memory can hold a reference, not a competing paraphrase. Tool outcomes and outstanding work belong to activity/task records. Distinct personal insight, such as “a short written checklist helps Ember begin,” can be memory if supported by conversation.

A small always-present memory plus retrieval is consistent with the bounded-memory approach documented by Hermes. Its session-frozen snapshot is a useful precedent for reproducibility, but Valerie intentionally refreshes at every new turn so dashboard changes become useful immediately. SQLite FTS5 supplies lexical search and ranking for an initial retrieval layer. Reflection/importance-based retrieval also has a research precedent in Generative Agents; that work supports the pattern, not a guarantee of personal-assistant reliability. [Hermes memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory), [FTS5](https://sqlite.org/fts5.html), [Generative Agents](https://arxiv.org/abs/2304.03442).

## Stores and authority

| Store | Contents | Inclusion / lifecycle |
| --- | --- | --- |
| Core | Explicit enduring preferences, essential relationship context, and user-pinned facts | Always included under a hard budget; never silently displaced. Character source remains separate. |
| Short term | Recent context, ongoing interests, provisional observations | Searchable; configurable expiry/review date, e.g. 7–30 days. Expiry archives it rather than declaring it false. |
| Long term | Supported durable personal facts, decisions, and reusable knowledge | Retrieved by relevance; superseded when corrected, reviewed when stale. |
| Topic map | Small topic/entity summaries and links to deeper records | Relevant branches injected; all branches searchable/pageable. No ever-growing global index in the prompt. |
| Conversation archive | Original messages and source references | Search by time/text when curated memory is insufficient; retention separate from operational logs. |
| Knowledge notes | Learned topic material with external source URL and checked-at date | Timestamped, tagged by provenance and freshness. Web claims are not facts about Ember. |

User corrections and current authoritative tools outrank inferred memory. Label personal statements, observations, and inferences separately. Sensitive inferred traits should not silently become identity facts. Core memory is explicitly pinned/approved; routine supported short/long notes may be self-managed within the configured policy.

### Obsidian and SQLite ownership

Markdown is authoritative for vault note content, titles, tags, and authored links. SQLite owns core/short-term records, original conversation evidence, exact ingested note revisions, retrieval indexes, audit history, reflection cursors, conflicts, and forgetting exclusions. Its copy of vault prose is a revisioned representation for retrieval and reproducible turns, not an independently editable competing source. A dashboard editor for a vault-backed note must use the same controlled file-write path.

Ordinary authored notes require no mandatory metadata or preprocessing. Index saved changes after they reach homelab; reflection is not a prerequisite for search. Track source hashes/revisions and index freshness, then capture selected content in each turn snapshot. A startup reconciliation scan must recover changes missed by the lifecycle-owned watcher. File renames and absent optional folders must not erase evidence or imply permissions.

Default read areas are `Inbox/`, `Notes/`, `Journal/`, `Topics/`, and `Valerie/Memories/`. `Archive/` is for explicit historical lookup. `Valerie/Suggestions/` is a proposal queue, not ordinary factual memory. Runtime-approved navigation and policy documents are not biographical evidence. Exclude `Private/`, hidden configuration, credentials, sync metadata, and backups; links and symlinks must not bypass exclusions. Attachment ingestion needs its own source/access checks.

Routine model writes are confined to `Valerie/Memories/` and `Valerie/Suggestions/`. Authored notes and topic pages require Ember's direct request to edit. Preserve unfamiliar frontmatter and authored prose. Validate expected source revisions before any change; preserve conflicting versions instead of overwriting an intervening Ember edit. Editing a vault policy document does not automatically change the runtime's enforced permission policy.

```ts
type MemoryRecord = {
  id: string;
  tier: "core" | "short" | "long";
  kind: "preference" | "fact" | "experience" | "knowledge" | "procedure";
  title: string;
  body: string;
  thoughts?: string;
  authoredBy?: "owner" | "valerie";
  topicIds: string[];
  provenance: { sourceType: string; sourceId: string; observedAt: string }[];
  evidenceType: "explicit" | "observed" | "inferred";
  importance: number;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  reviewAfter?: string;
  expiresAt?: string;
  supersedesId?: string;
  state: "active" | "superseded" | "archived";
  version: number;
};
```

Use `memory_link(fromId,toId,relation)` for `supports`, `contradicts`, `related`, and topic membership; use `topic(id,parentId,title,summary,revision)` for navigable hierarchy. Multiple topic links avoid forcing every memory into exactly one category. Detect cycles during traversal and apply depth/result budgets.

## Retrieval and context budget

At turn start reserve fixed portions of the effective context window for the user request, output/tool loop, character, and recent dialogue. A starting curated-memory budget might be 1,500 tokens core, 500–1,000 topic-map tokens, and 2,000 retrieved-memory tokens; make these visible and adjustable. Do not silently truncate a pinned core record. Show a core-over-budget conflict for an intentional edit/consolidation.

Start retrieval with normalized keywords, entity/topic match, FTS rank, freshness, and importance. Blend scores using a documented local heuristic; inspect selected IDs in the dashboard. Return snippets with title, observed date, tier, evidence type, source IDs, and reasons for selection. Use tools such as `memory.search`, `memory.read`, `memory.related`, `topics.list`, and `conversation.search`. Each result is bounded and offers a cursor or IDs for deeper traversal.

Add embeddings only when a fixture set demonstrates that lexical/topic retrieval misses paraphrases or cross-topic relationships. Keep embeddings as a rebuildable index keyed by memory revision/model, not as the canonical store. Hybrid rank fusion is a later implementation choice. A graph database is unnecessary until measured relational queries cannot be served by SQLite links.

Relevant dynamic records are fetched from their owner at answer time. For “is my appointment reminder snoozed?” use `reminders.get`, even if old chat says otherwise. For “what did you do yesterday?” search activities. Do not expand context with every tool definition or all raw logs to answer a small question.

## Daily reflection transaction

Run a low-priority job at a configured local time, keyed by local date/timezone and a cursor range. It may finish silently with no changes. Capture the selected prompt/config version and a bounded digest of messages, tool outcomes, failures, and explicit usage signals since the last committed cursor. “Usage” means Valerie's own requests/actions, not ambient screen surveillance.

1. Read sources and identify candidate learning, contradictions, stale notes, repeat preferences, and recurring friction. Tool failures cannot become claims that work succeeded.
2. Assign ownership before writing. Reject reminder/logistics copies and proposed persona rewrites. Retain references to live records where useful.
3. Search existing notes/topics for every candidate; propose update/merge/supersede rather than saving paraphrased duplicates.
4. Decide supported new short/long notes. Promote short to long for repeated evidence or a clearly durable explicit fact; age or frequent retrieval alone is insufficient. Core promotion becomes an Ember-visible proposal unless explicitly allowed by standing policy.
5. Validate source IDs, size limits, links, tier/authority rules, dedupe fingerprints, and expected record revisions in code.
6. SQLite-only edits and the processed cursor can commit atomically, with one `reflection_run` audit and before/after references. Vault-backed edits require a durable write journal keyed by run/range and operation ID: record intended content and expected source hash, apply each permitted file change atomically, and reconcile its actual result after a crash. Only complete the run and advance its cursor after the journaled changes are confirmed or explicitly retained as unresolved proposals. File writes and SQLite commits are not one transaction. Retry must recognize already-applied content and preserve later user changes. Keep a change log with undo; a repeated date/range cannot duplicate changes.
7. Store `improvement_proposal(title, problem, evidenceIds, expectedBenefit, suggestedChange, status)` separately. It may recommend a feature or prompt tweak; it does not modify code, install tools, change the soul, or restart itself.

Daily catch-up is bounded after downtime: process missed ranges in digest chunks, avoid several unsolicited “I reflected” messages, and record any unprocessed range. Higher-priority user messages or reminders can pause reflection between model requests. Token/cost ceilings prevent an expensive history reread every day.

## Dashboard and failure behavior

Show searchable notes with tier, topic, provenance, last update, expiry/review date, and version history. Allow edit, pin, archive, forget, restore, and rebuild search index. “Forget” must define whether source messages are also deleted and track backup retention; deleting only an embedding is not deletion of the fact. Reflection suggestions have a separate queue and are quiet unless a meaningful proposal is requested or configured for digest delivery.

Malformed reflection output: no writes; retain a recoverable run error. Concurrent memory edit: optimistic conflict, recompute the affected proposal. Missing sources: reject unsupported writes. Provider outage: defer reflection, while current conversation and existing memory remain usable. Stale factual sources: label checked-at and refresh through the relevant tool rather than asserting current truth.

## Delivery phases and acceptance

**First:** canonical records, explicit save/search/read, simple topic map, short/long/core budgets, correction/supersession. **Then:** idempotent daily reflection, dedupe/promotion, suggestion queue, richer map and retrieval evaluation.

- Recall a supported preference across restarts and retrieve its original evidence. A unique old phrase is searchable even when it was never promoted to curated memory.
- A corrected fact supersedes the old one; a stale reminder copy never overrides current reminder status.
- Two reflection runs over the same range create no duplicates. A crash at each commit boundary leaves a complete old or new state.
- A short-term note expires without destroying its evidence; a stable explicit preference can promote with the reason recorded.
- Large archives leave the injected memory within budget while a deep topic question can fetch further pages without loops.
- Malicious instructions quoted in an email/webpage/log remain sourced content and cannot alter prompts, authorize tools, or promote themselves into core.
- Ember can inspect/undo a reflection change and see suggestions without those suggestions being applied automatically.
