# Context health and conditional prompts

Status: implemented and active on homelab alongside Growth Focus, verified 2026-09-15. Owner request: make increasing context pressure visible and provide a useful warning Ember can bring back for diagnosis.

## What the warning means

The desired long-term warning threshold is where the deployed model's quality begins to deteriorate. No validated numerical cutoff is currently established for Neuralwatt's `glm-5.3-flash` with Valerie's prompt, reasoning setting and conversation tasks.

Do not substitute an arbitrary percentage of the advertised context maximum and label it quality degradation. Do not ask the model to estimate its own token usage or diagnose a context limit from how it feels. The application must supply actual measurements and known outcomes.

Current inspection found no recorded capacity-related history trimming, context-budget failures or output-budget truncation in the inspected production records. This is not proof of perfect answer quality.

## Measurements

Record and display these separately:

- Actual provider-reported input/output/reasoning/cache tokens for each request.
- Peak input size within a turn, separately from cumulative tokens across multiple tool calls.
- Application context allowance, reply reserve, tool allowance and selected history/memory.
- Component estimates for character/relationship/voice, current input, recent history, memory, feature instructions, tool schemas/results and image allowance.
- Omission reasons: normal age window, size budget, failed/unconfirmed exchange, unavailable source or media limit.
- Context refusal, tool continuation stopped for context, and output exhaustion as different outcomes.
- Model alias/capability timestamp, prompt/settings revisions, request/turn references and request elapsed time.

The current core/history estimator budgets one UTF-8 byte as one token plus overhead/image allowances; the inference adapter separately uses a bytes/3 heuristic. Neither is the model's exact tokenizer. Label estimates distinctly from provider token measurements.

## Warning behavior

Before quality calibration exists, flag objective events rather than asserting degraded cognition: recent history omitted specifically because of size, a fixed prompt/current input that cannot fit, or a tool continuation blocked by context. Label completion/reasoning-budget exhaustion separately; it is not proof that the input context was too large. Ordinary 48-hour history expiry should not trigger a warning.

A model-quality warning threshold remains unset until a defensible calibration is available. If an early capacity-percentage warning is later chosen, describe it explicitly as an operational heuristic, not a measured quality boundary.

The owner authorized brief context notices in Telegram. Produce them from application evidence through the durable delivery path. Deduplicate an ongoing warning condition; do not repeat it in every reply or turn it into a casual heartbeat. Do not count diagnostic notices as warm heartbeats. Preserve unknown-send handling and notification recovery.

Dynamic Details shows actual warning-delivery status. A definitively failed warning for an ongoing condition can be retried explicitly from the dashboard after the delivery problem is resolved. Unknown deliveries are not replayed; resolved conditions cannot revive an old warning. A retry queues the same warning and does not claim successful delivery.

Provide a compact diagnostic reference or shareable report with measurements, model/revisions and precise reason. Exclude raw prompts, private messages, media, credentials and provider error bodies by default. Preserve detailed evidence privately for owner-authorized inspection.

## Calibrating quality

Calibration remains future work. The first release uses objective application signals and reports the quality threshold as uncalibrated. This is an explicit limit, not a hidden percentage of the advertised context capacity.

Use fictional Valerie-like conversation tasks at several input lengths, holding task difficulty and information content controlled. Include recent corrections, waking-day reasoning, preference recall, rules versus feeling disclosures, source attribution, tone and tool correctness. Test relevant information in different positions and with realistic distractors, with repeats to distinguish sustained decline from a single mistake.

Pin the deployed alias, explicit reasoning effort and output allowance. Keep input-length effects separate from output truncation, retrieval misses, conflicting instructions or tool failures. Record actual input tokens from the provider. A locally measured threshold belongs to its evaluation profile and must be reconsidered after material model/prompt/settings changes.

The [Chroma context study](https://www.trychroma.com/research/context-rot) is evidence that context performance can vary with length and task, not a calibration for this GLM alias. The [publisher's model card](https://huggingface.co/zai-org/GLM-5.3-Flash/blob/main/README.md) does not establish a quality-warning cutoff for this application.

## Conditional prompt direction

Keep identity, character/relationship/voice, core permissions, essential owner context and time interpretation stable. Preserve authored bytes; do not silently rewrite the character to reduce tokens.

Existing selection already separates text/voice, memory-tool guidance, image-tool guidance, heartbeat guidance and dormant reflection/reminder sections. Extend the same principle to Dynamic Details:

- Habit check-in instructions only for the appropriate waking/evening event or relevant user request.
- Compact applicable agreements in ordinary context; full rule history and detailed statistics on demand.
- A compact current Growth Focus, with longer practice guidance and progress notes retrieved when useful.
- Detailed tool instructions when the capability is actually offered/needed, retaining a dependable discovery path for indirect requests.
- Historical analytics and reflection material outside routine conversation unless relevant.

Measure token use, latency, cache behavior and task correctness before and after changes. Avoid a costly extra routing call solely to save a small prompt section without evidence of net benefit.
