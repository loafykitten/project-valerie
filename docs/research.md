# Project Valerie: research and development map

Research checked: **2026-09-11**. Desktop target: **macOS first**. These documents distinguish documented third-party capabilities from Valerie's proposed behavior. A design or acceptance criterion below is not a claim that the scaffold already implements it; consult the repository's implementation status before enabling a feature.

## Recommended shape

Build a Bun/TypeScript workspace with a single modular server, a React dashboard organized by feature, shared contracts, and a later desktop client. Keep the database and integration credentials on the homelab. The Mac runs the avatar, audio playback, and narrow desktop controls. Splitting source packages does not require splitting the server into independently deployed services.

Start with SQLite on local homelab storage, WAL mode, explicit migrations, and FTS5 for searchable memories and activity. Bun provides a native SQLite API; SQLite WAL permits concurrent readers with a writer, but still has one writer at a time and requires participants on the same host. Keep transactions short and never wait for a model or network request inside one. This is a good fit for one companion; a distributed database and vector service add operational work before evidence requires them. [Bun SQLite](https://bun.sh/docs/runtime/sqlite), [SQLite WAL](https://sqlite.org/wal.html), [FTS5](https://sqlite.org/fts5.html).

Treat prompts, memory rules, schedules, expression mappings, voice choices, and tool enablement as versioned data. Saving a valid configuration changes the **next turn** or next job boundary immediately. Capture one configuration revision for each in-flight turn. Code, dependency, and schema changes use graceful process replacement with persistent queues. Bun's `--hot` preserves process state while reloading modules and `--watch` restarts the process; neither alone guarantees that production pollers, timers, and listeners cannot be duplicated. Use them for development, not as the availability design. [Bun watch mode](https://bun.sh/docs/runtime/watch-mode).

## Feature specifications

| Feature document | Development scope | Initial priority |
| --- | --- | --- |
| [Prompts and character](features/prompts-character.md) | Dashboard editor, immediate saves, versions, exact card import, channel prompts, personality and relationship | First |
| [Inference and tools](features/inference-tools.md) | Neuralwatt adapter, bounded agent loop, capability checks, extensible tool contracts | First |
| [Telegram and media](features/telegram-media.md) | Immersive text, image generation with local ComfyUI, ElevenLabs voice notes, delivery durability | First |
| [Memory and reflection](features/memory-reflection.md) | Core/short/long memory, topic map, retrieval, promotion, daily reflection and improvement proposals | First usable release, then deepen |
| [Reminders and automation](features/reminders-automation.md) | Reminder lifecycle, recurrence/snooze, interval jobs, independent casual heartbeats | First usable release |
| [Activity and diagnostics](features/activity-diagnostics.md) | System watching, seven-day detail, durable task outcomes, “What are you up to?”, metrics | First usable release |
| [Desktop, VRM and emotion](features/desktop-vrm-emotion.md) | macOS transparent window, drag/click behavior, animation and expression mixing, audio synchronization | After server is useful |
| [Email and calendar](features/email-calendar.md) | Provider-specific synchronization, search, drafts and calendar editing, authorization | After provider selection |

## Decisions and evidence

| Decision | Verified capability | Valerie recommendation / consequence |
| --- | --- | --- |
| Own a small application rather than embed a general assistant framework | OpenClaw documents persistent automation jobs; Hermes documents bounded memory and a broader tool ecosystem. | Borrow durable scheduling and bounded retrieval ideas, while preserving Valerie's character and channel behavior in a readable codebase. No framework dependency is necessary to get those properties. [OpenClaw automation](https://docs.openclaw.ai/cron-jobs), [Hermes memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory). |
| Neuralwatt first | Its chat API supports chat messages and tools; its authenticated models catalog exposes capability metadata. | One adapter and one small internal inference interface. Add a second adapter only when a second provider is actually used. [Chat API](https://docs.neuralwatt.com/api/chat-completions), [models](https://docs.neuralwatt.com/api/models). |
| Telegram long polling first | Telegram offers mutually exclusive polling/webhooks and retains pending updates no longer than 24 hours. | Homelab needs no public webhook. Persist inbound updates before acknowledging them; only one live poller per bot token. [Bot API](https://core.telegram.org/bots/api#getting-updates). |
| Separate speech text from visible text | ElevenLabs provides speech plus character alignment, while Telegram has a dedicated voice-message method. | Generate voice-specific prose; never force the text character's actions into the spoken channel. [ElevenLabs timing](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps), [Telegram voice](https://core.telegram.org/bots/api#sendvoice). |
| Electron first desktop spike | Electron documents transparent windows and mouse-event ignoring. Tauri exposes macOS transparency through a private-API option. | Electron keeps desktop work in TypeScript. Prove click-through, dragging, Spaces, and audio on the actual Mac before building the polished avatar client. [Window styles](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles), [interactions](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions), [Tauri configuration](https://v2.tauri.app/reference/config/#macosprivateapi). |
| Keep authored character data intact | SillyTavern's parser reads PNG text chunks and gives `ccv3` precedence over `chara`. | Preserve the original file and all decoded data; use a separate display-name override for Valerie. No automatic prose cleanup. [SillyTavern parser](https://github.com/SillyTavern/SillyTavern/blob/release/src/character-card-parser.js). |
| Small core plus searchable depth | Hermes illustrates a bounded prompt memory; FTS5 provides indexed lexical retrieval. | Always inject a compact, explicit core plus a small relevant topic index. Fetch detailed memories through tools. Add embeddings only after retrieval evaluation demonstrates missed paraphrases. [Hermes memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory), [FTS5](https://sqlite.org/fts5.html). |

The user mentioned “the new Muse assistant.” Search surfaced several unrelated Muse products, including [wlsdks/muse-agent](https://github.com/wlsdks/muse-agent); its identity has not been confirmed. Do not attribute that project's features to the intended Muse or make it an architectural dependency. OpenClaw, Hermes, C.ai, and Janitor AI are inspirations for capabilities or experience, not migration targets.

## Release sequence and gates

1. **Foundation:** workspaces, typed configuration, SQLite migrations, structured activity, local/private dashboard, prompt editing with persisted revisions, provider health view. No integration can silently start without its required credentials and enable switch.
2. **A conversation that feels like Valerie:** import the supplied card without edits, assemble channel-specific prompts, connect Neuralwatt, make Telegram text durable and single-owner, record conversations and tool outcomes. Character fidelity is reviewed using real user examples; fabricated persona filler is not a substitute for the card.
3. **Useful daily assistance:** core/short/long memory and retrieval, reminder state machine and recovery, activity search and outstanding-work view, read-only system watching. Implement reflection and heartbeat policies only after the durable records they depend on exist.
4. **Richer communication:** approve a local ComfyUI workflow and map its inputs, verify ElevenLabs voice/model eligibility, deliver actual Telegram voice messages and photos. Add classification/emotion sidecars without changing visible text.
5. **Desktop presence:** Electron spike, three-vrm model loading, animation mixing, audio playback acknowledgments, lip sync, reconnect behavior, macOS packaging.
6. **Connected organizer and ongoing learning:** chosen email/calendar adapter, interval news jobs, diagnostic trends, reflection-driven suggestions. Suggestions become reviewed development work; they do not rewrite Valerie's soul or self-deploy code.

Every milestone should have a small offline contract suite plus a documented live check using the actual account/client. An API returning 200 does not prove Telegram displayed a voice note correctly, and a valid VRM load does not prove facial animation looks right.

## Runtime rules that cross feature boundaries

- Every turn, tool call, schedule occurrence, provider request, and outbound delivery has a correlation ID. Persist outcomes, not unlimited raw context.
- One user-facing conversation queue preserves ordering. Background reflection/maintenance uses lower-priority work and cannot starve direct replies or due reminders.
- The database owns reminders and schedules. Memory owns personal context and learned knowledge. Activity owns what actually happened. Avoid competing copies of live state.
- A delivered message is counted only after a confirmed provider response. An ambiguous send is a distinct state; Telegram does not give the application a universal exactly-once delivery transaction.
- Secrets, raw logs, private message archives, generated media, and original character assets belong in ignored runtime storage and backups, not Git—even in a private repository.
- Configuration saves are atomic and versioned. Invalid edits leave the last valid revision active. Rollback creates a new revision referencing its predecessor.
- The existing LegacyNudges service must be stopped and disabled before Valerie's Telegram poller or proactive jobs are enabled. Back up state first, check outstanding reminders, and retain a concrete rollback plan. Do not infer that an imported persona implies migrated reminders or memory.

## Inputs still needed for live completeness

The original SillyTavern PNG is now supplied locally; its private first-import workflow is documented in [character import](character-import.md). Remaining live inputs include: chosen conversational Neuralwatt model; Telegram bot token and permitted user/chat; ElevenLabs voice ID/model eligibility; local ComfyUI address and approved API-format workflow; a VRM asset/animation set; email/calendar provider and account authorization. These do not block offline development. Discover existing configuration privately when authorized, but do not print secrets or assume an old service's configuration represents the desired new deployment.

## Evaluation and cost

Maintain a small, user-owned conversation fixture set: natural casual replies; task motivation; simple and ambiguous reminders; corrections to facts; action-rich text; spoken answers; “What are you up to?”; unavailable tools; and conflicting stale records. Evaluate character fidelity separately from tool correctness. Use fixed time/token budgets and a few repetitions for stochastic checks rather than open-ended model competitions.

Track actual inference usage when available, estimated cost separately, TTS characters/audio duration, image job duration, queue delays, and delivery failures. Record why each background call ran. Silence is a valid heartbeat/reflection outcome and should be inexpensive. No per-turn emotion call or embedding service is required to ship the first conversation loop.
