# Character-requested images

Implemented September 13, 2026. Core owns durable image jobs, immutable generated media and delivery receipts; the server owns the ComfyUI adapter, tool binding and Telegram lifecycle; inference owns the bounded tool protocol; the Conversation dashboard shows images and actual outcomes. Public entry points are `createImageJobService`, `createImageRuntime`, and `createConversationGenerator`.

Ask Valerie for a selfie or a picture in Telegram. Her selected model calls `generate_image` with `framing` (`selfie` or `full_body`) and up to twelve short scene tags. One invalid-argument result allows one corrective model call before the final response, for at most three inference requests within the same two-minute deadline and one queued image. Rejected calls and their usage remain recorded. After the request is stored, the model writes its own brief acknowledgement saying the picture will take a moment. Its initial unconfirmed prose is never sent. Rendering runs independently, so conversation can continue. The final photo replies to the originating Telegram message and appears beside that turn in the dashboard, which refreshes automatically.

The application preserves the private workflow's identity, model, LoRA, dimensions, sampler, negatives, detector and face-refinement settings. Scene composition replaces node 3 completely: protected identity, selected framing, scene tags, style. Selfies remove the original full-body/outfit defaults. Node 6 receives a fresh persisted unsigned 32-bit seed; nodes 8 and 17 receive application-owned unique output prefixes. An open-mouth scene adds fangs. The supplied authored files remain byte-for-byte in private production storage, outside Git and review snapshots.

The renderer API follows the [ComfyUI server routes](https://docs.comfy.org/development/comfyui-server/comms_routes); the model uses [Neuralwatt tool calling](https://docs.neuralwatt.com/api/chat-completions). Tools are exposed only when configured and supported by the saved authenticated model capabilities. Model arguments cannot select hosts, workflows, paths, seeds or rendering settings. Quoted text, old messages and character prose do not authorize a new image request. Scene validation rejects unsupported syntax and conflicting identity/framing tags.

## Prompts in the dashboard

**Prompts → Image Generation** contains the instructions Valerie uses to choose scene details and acknowledge an image request. It starts with the previously used instruction text. The existing editor saves revisions; new turns capture the saved content and version together with the other prompts, including intentionally empty content. It participates in saved prompt order and the configured Telegram-text preview, and is omitted from speech and conversations without image-tool support. Existing in-progress turns keep their original snapshot.

**Conversation → Image prompt**, below each generated image, shows that job's exact stored positive prompt, base negative prompt, additional face guidance/negative prompt, framing, scene tags and seed. These values are read-only and loaded when expanded. The protected endpoint exposes only those fields from the pinned job, not its workflow graph, paths, credentials or internal tool trace. Editing Image Generation does not change historical image prompts or the workflow's protected identity/render settings.

## Configuration and lifecycle

Set both server-only variables and recreate the API container:

- `COMFYUI_BASE_URL`: the private Mac ComfyUI origin reachable from the API container.
- `COMFYUI_WORKFLOW_DIR`: an absolute private directory containing `comfyui-val.api.template.json` and `prompt-profile.json`.

Production stores the entire supplied bundle at `/home/ember/.local/state/project-valerie/image-generation/bundle`, mounted as `/var/lib/valerie/image-generation/bundle`. The workflow is validated at startup and copied into each durable job. Changing configuration requires a controlled restart; an existing job keeps its exact graph, seed, scene and tool invocation. Both settings absent disables image tools. Partial or invalid configuration fails startup.

Migration 007 adds `core_image_jobs`, `core_generated_images`, and `core_image_failure_notices`. The runtime contract is `character-images-v3-sqlite-007`; v3 adds the revisioned image direction without another schema migration. The existing Telegram worker lease owns rendering, polling, generation and delivery; no second poller, broker or service was added. Render operations recheck ownership around network calls and before durable changes, including after a delayed response. Hot HTTP reload does not start another background loop. Original text and character prompts are preserved.

## Failure and delivery behavior

One request per source turn is stored atomically; a model retry resumes its stored invocation. One render is active at a time. The canonical Comfy prompt UUID is persisted before POST. An uncertain POST is never repeated: history and queue are reconciled until the fifteen-minute deadline. Every request has a shorter deadline and bounded response size; redirects and raw provider errors are rejected. An unexpected returned ID is retained for audit and reconciliation.

Success requires completed successful history, node 8, and the exact job's output namespace. Node 17 is never delivered as the final image. Downloaded PNG bytes are bounded to 5 MiB, inspected, hashed and stored immutably in private SQLite before delivery. The media endpoint retains existing host/origin protections and serves no ComfyUI paths or URLs.

Photo delivery normally follows the acknowledgement receipt. A terminal acknowledgement failure does not strand a successfully generated photo. Confirmed Telegram receipts alone mark photos sent; only explicit rate limits permit up to three send attempts. An uncertain send remains unknown and is not replayed on restart. This avoids duplicate application dispatch, without claiming that Telegram provides exactly-once delivery.

Terminal image failures or uncertainty produce a separately stored message generated from the requesting turn's original voice and settings. Failure notices have their own receipts and are never recursively retried after an ambiguous send. If generating or delivering the notice also fails, the dashboard retains the outcome. Recent image outcome records enter subsequent turn snapshots. Generated pixels are currently available in Telegram and the dashboard, not reintroduced into later inference context. Refinement can be skipped by the workflow's detector; successful node-8 output does not prove a face was changed.

## Acceptance

Deterministic tests cover prompt composition and identity boundaries; bounded tool calls and model-written acknowledgement; immutable jobs/media and replay prevention; queued/success/failure/missing-node cases; uncertain submission reconciliation; exact output ownership; private previews; chat during rendering; photo and failure-notice receipts; lease ownership and restart behavior. A mock transport does not establish live rendering quality or Telegram display.
