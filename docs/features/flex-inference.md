# Neuralwatt Flex inference

Owner: `packages/inference` for the provider protocol; server generators and Telegram worker for deadlines; core context health for immutable receipts; dashboard for selection and status. Public entry point: `createNeuralwattClient().complete()` and the existing Conversation model selector.

Select an authenticated `-flex` model in **Conversation → Model**. The adapter sends `stream: true` and requests usage, assembles the result internally, and returns the same complete text/tool result used by the existing conversation pipeline. Telegram still receives complete replies. Standard aliases retain non-streaming JSON requests. No separate provider, service, dependency, or model fallback is added.

Neuralwatt requires streaming for Flex admission and pricing. A non-streaming Flex request uses the standard tier instead. Flex can wait for spare capacity; the alias alone is not a billing receipt. See the provider's [Flex contract](https://docs.neuralwatt.com/guides/flex-tier) and [streaming protocol](https://docs.neuralwatt.com/guides/streaming).

## Completion and failure boundaries

- Streaming handles fragmented UTF-8, LF/CRLF/CR line endings, multiline data, keepalive comments, usage-only chunks and indexed tool-call fragments. Reasoning is discarded; hosted tools remain disabled.
- A recognized finish reason and `[DONE]` are required. Truncated streams, malformed data, provider error events, conflicting known service tiers and unrequested/invalid tools fail before text delivery or tool execution. An exhausted output allowance stays incomplete.
- Limits: 16 MiB total stream bytes, 256 Ki characters per line/data event, 1 MiB assembled visible text, four tool calls and 8 KiB arguments per call. Existing request/image/schema limits still apply. The larger wire limit allows streaming envelope overhead, not larger model output.
- Flex conversations share a five-minute deadline across tool rounds. The worker allows five additional seconds for cleanup. Flex heartbeats have a five-minute generation limit and retain fresh-input cancellation and stale-send checks. Standard deadlines are unchanged.
- Exact reminders and coordinated check-ins retain their existing 45-second provider / 55-second worker limits and saved fallback/expiry policy. They use streaming on Flex but cannot wait indefinitely for it. Explicit reminder delivery remains independent of ordinary conversation generation.
- The adapter never retries or changes to a standard model. Existing bounded worker retry rules remain in force; a new request may be billed again. Telegram delivery uncertainty is still recorded as unknown, without blind replay.

## Receipts and dashboard

`serviceTier` records `flex`, `standard`, or unknown from provider response metadata, never from the requested alias. The adapter reads both streamed chunks and `X-NW-Service-Tier`, rejecting contradictory known values. `costUsd` preserves a finite nonnegative provider `request_cost_usd`, including zero; absent costs remain unknown. It is a provider-reported amount, not a locally estimated invoice.

Migration 021 adds nullable tier/cost fields to immutable per-request context receipts. Historical receipts remain unknown. Every conversation tool invocation and heartbeat keeps its individual receipt before cumulative usage replaces the turn-level totals. Cumulative conversation metadata records a tier only when every contributing request has the same known tier; mixed or missing receipts remain unknown. Scheduled generation retains the completion in its existing result journal.

**Dynamic Details → Context health → Recent diagnostics** lists each request's confirmed tier and reported cost when available. A standard receipt on a Flex model explicitly shows that Flex was not applied. The model selector explains possible waits. Unknown tiers and missing costs are not displayed as discounted or free.

## Acceptance

Deterministic coverage includes fragmentation, keepalives, streamed tools and continuation, image-proposal execution boundaries, incomplete output, interruption, deadlines, body limits, accounting, old/unknown receipts and immutable persistence. Run `bun run check` and `bun run test:hot`.

Live acceptance uses only fictional text, synthetic imagery and temporary memory databases:

```sh
bun scripts/inference-probe.ts probe glm-5.3-flash-flex
bun scripts/inference-image-probe.ts probe glm-5.3-flash-flex
```

Each Flex probe requires actual Flex receipts. No probe uses production prompts, owner history, vault contents or Telegram transport.

Activation requires a private backup, migration rehearsal, runtime-contract bump and controlled API restart. Saving a different model then affects new snapshots; already captured turns retain their selected model and settings.
