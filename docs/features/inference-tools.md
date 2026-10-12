# Inference service and extensible tools

Status: development specification. Research checked 2026-09-11. Depends on prompt snapshots, conversation storage, activity records, and durable turn jobs. Neuralwatt is the initial provider; model/account selections remain a live configuration input.

Implemented first tool runtime, 2026-09-14: feature-registered memory search/read/related, topics, conversation archive search/read, source-backed synthesized short saves and activity reads share a bounded loop with character images. New memory-enabled snapshots use at most six tool rounds, twelve calls, one invalid-argument repair and a 120-second turn deadline. The configured context ceiling bounds schemas, arguments and results using conservative byte accounting; oversized proposals are rejected before effects, and accepted evidence pairs remain intact. Each provider tool round and outcome is durable; read replay uses the recorded result, and synchronous SQLite mutations commit with their outcome. Memory saves can summarize earlier or current owner messages and keep tentative thoughts separate. Source IDs are validated against the same owner/conversation and the current-or-earlier turn; updates require an active short record and its expected version. Saves return a compact receipt; original evidence remains readable through conversation_read. Invalid sources and stale versions have specific correction reasons. Behavioral memory instructions are revisioned in Prompts → Memory Use. Core pinning and vault writes are unavailable to the model. No external-write tool is registered. Older image-only snapshots retain their original retry path. Timed-out reads must honor cancellation and cannot be repurposed as asynchronous mutations. Streaming, external adapters/MCP, general tool enablement UI and reflection remain planned.

The reminder time/style follow-up uses catalog `agreements-018-v4` for new turns, with duration/local-time arguments and application-formatted saved confirmations. Earlier snapshots retain v1/v2/v3 and pre-catalog contracts. The repair loop keeps its existing limits; reminder validation now names missing fields and tells the model to retain other arguments. This improves diagnosis while preserving required versions and permission checks.

## Provider boundary

Neuralwatt exposes `POST https://api.neuralwatt.com/v1/chat/completions`, streaming, tool definitions, and provider-specific reasoning behavior. Its authenticated `/v1/models` response identifies customer scope and advertises capabilities, context/output limits, reasoning contracts, and pricing. Generic OpenAI compatibility does not mean all models support the same options. [Chat completions](https://docs.neuralwatt.com/api/chat-completions), [model catalog](https://docs.neuralwatt.com/api/models).

Use a thin `InferenceProvider` with `complete(request, signal)` and eventually `stream(request, signal)`, plus capability discovery. Keep Neuralwatt wire types, authentication, error parsing, SSE details, and model-specific mappings inside its adapter. Core receives normalized messages, validated tool calls, finish reason, usage, request ID, and timing. Avoid a provider marketplace, routing DSL, autonomous model swapping, or a heavyweight agent framework at this stage.

Proposed contracts (names illustrative; implementation schemas are authoritative):

```ts
type TurnKind = "user" | "reminder" | "interval" | "heartbeat" | "reflection";
type InferenceRequest = {
  turnId: string;
  model: string;
  messages: ModelMessage[];
  tools: ToolSchema[];
  maxOutputTokens: number;
  deadlineAt: string;
  configRevision: number;
};
type InferenceResult = {
  text: string;
  toolCalls: { id: string; name: string; arguments: unknown }[];
  finishReason: "stop" | "tools" | "length" | "other";
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  billedCostUsd?: number;
  estimatedCostUsd?: number;
  requestId?: string;
};
```

At configuration time, list authenticated models and require customer scope. Verify the selected model with a minimal direct reply and a harmless tool round trip. Record model ID and checked-at time. Do not commit a customer's catalog into source or auto-select a public fallback when authentication is absent. Vision is needed only if incoming images are passed to that model; outgoing ComfyUI images alone do not require it. Leave unsupported `reasoning_effort`, JSON mode, temperature, and other options absent.

## Agent loop

1. Acquire the conversation's turn slot. Archive incoming user material and its source IDs once; repeated Telegram updates refer to the same message.
2. Build the prompt/configuration snapshot; add bounded recent history, current local time/timezone, core memory, small topic map, and relevant live state/tool schemas.
3. Run inference with an overall deadline, output limit, and cancellation signal.
4. Validate tool names and arguments. Execute permitted calls with bounded concurrency: independent reads can overlap; dependent mutations stay ordered. Save each outcome before proceeding.
5. Return compact tool results with evidence references. Retry a malformed read request only within a small correction budget; do not repeatedly ask the model to repair a dangerous or unavailable action.
6. Continue until a final reply or the turn's tool-round/time budget ends. Suggested starting limits: six tool rounds, twelve calls, one argument-repair attempt, explicit larger budgets only for named work.
7. Persist the final result and enqueue the chosen delivery. If the limit is reached, report the partial outcome and what remains; never imply all tools succeeded.

Work requiring minutes becomes a durable activity/task with a task ID and bounded follow-up jobs. It must not hold the interactive conversation lock indefinitely. Track cancellation of model generation separately from cancellation of an already-started external action.

## Tools as feature modules

```ts
type ToolDefinition<I, O> = {
  name: string;                     // stable feature.action
  description: string;
  inputSchema: Schema<I>;
  outputSchema: Schema<O>;
  effect: "read" | "local_write" | "external_write";
  allowedTurnKinds: TurnKind[];
  timeoutMs: number;
  maxOutputBytes: number;
  execute(input: I, context: ToolContext): Promise<O>;
};
```

Each feature registers tools beside its service/repository. The registry supplies model JSON schemas, API validation, permission checks, timeout/cancellation, redaction, activity summaries, and consistent errors. A new web search tool should add one adapter, one typed declaration, configuration, and contract tests; it should not require edits across Telegram, memory, and every prompt.

Use internal functions first. MCP later fits behind the same registry when an actual useful server is selected. MCP's schema and discovery conventions are useful, but tool annotations alone are not authorization; tool results and descriptions from remote servers remain untrusted data. Pin/approve a server and expose only selected tools. [MCP tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).

Tools that send email, edit external calendars, or run commands require an authorization policy tied to Ember's request or explicitly configured standing rule. Routine local memory and reminder updates within a direct request need no repetitive approval. The language model cannot manufacture authorization from an email, webpage, tool output, or its own character prompt. For scheduled work, the saved job records exactly which effects its owner authorized.

## Streaming, cost, and failures

[Flex inference](flex-inference.md) now buffers SSE internally and retains complete replies for Telegram; desktop speech can later consume bounded sentence segments. Do not forward reasoning fields, JSON envelopes, tool arguments, or partial malformed content into visible chat.

Neuralwatt documents SSE extensions for accounting. Preserve recognized provider metadata rather than relying on an SDK that drops comment frames. Store actual billed values separately from locally estimated token prices; missing accounting is unknown, not zero. Capture provider request IDs for troubleshooting without putting credentials or identifying user text in request headers. [Neuralwatt streaming](https://docs.neuralwatt.com/guides/streaming).

On 401/403: mark configuration/action required; no endless retry. On 429: respect retry timing with jitter and a turn deadline. On transient connection/5xx failure: bounded retry only if no side effect or output has been committed; avoid replaying a whole completed tool loop. On context overflow: rebuild a smaller snapshot with explicit omissions, preserving current user text and tool pairs. On missing tools/capability: explain the limitation and keep partial work evidence. A provider failure never falls back to an unrelated reminder inventory.

Only the tool result establishes action success. A model sentence saying “I've scheduled it” without a successful reminder result is not a completed action. This invariant should be enforced through evaluation and, for structured action flows, delivery validation.

## Delivery phases and acceptance

**Implemented:** one Neuralwatt adapter, complete text, image input, bounded tool loop, model/capability settings and health, evidence-backed activity, and buffered SSE for Flex with tier/cost receipts. **Later:** invoice reconciliation, visible incremental output where useful, and narrowly scoped external providers/MCP.

- Offline fake provider verifies a tool round trip, malformed arguments, unsupported tools, timeouts, cancellation, budget exhaustion, and matching tool-call IDs.
- A real selected model passes a harmless tool call and plain-text response; unsupported parameters are absent from the request.
- Two rapid user messages remain ordered; a slow image task does not block a later “stop” or status request indefinitely.
- Replay after process failure does not repeat an already committed local mutation. External tools use operation keys/provider preconditions where available and expose ambiguity where not.
- Logs distinguish authentication, rate limit, timeout, network, malformed response, and model exhaustion without revealing keys or full prompt content.
- Add a tiny test tool without changing channel adapters. Its output is bounded, logged, and unavailable in forbidden turn kinds.
