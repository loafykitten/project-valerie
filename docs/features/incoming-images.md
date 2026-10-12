# Incoming Telegram images

Owner: server Telegram transport/worker; core conversation attachments and snapshots; inference multimodal transport; dashboard Conversation previews. Replies remain ordinary Telegram text. Image generation, outgoing media, voice, and memory are separate milestones.

## Accepted inputs

The private owner chat accepts ordinary Telegram photos and JPEG, PNG, or WebP image documents, with or without a caption. Select the largest available photo variant within the configured safety bounds. Preserve captions verbatim. Other senders/groups/bots remain outside the allowlist and never trigger downloads. Unsupported image documents and oversized images receive a durable failure record instead of being passed to the model as if understood.

Telegram albums are collected with a 750 ms quiet interval and a maximum three-second collection interval. Each source update/message/caption is archived and deduplicated individually, while an open album shares one parent conversation turn. A late member received after capture starts another turn; it cannot mutate an in-flight snapshot. At most ten images belong to one turn.

Mixed albums preserve the captions of unsupported members such as videos. When an album has readable photos, Valerie receives those photos plus explicit markers for rejected or unavailable members. She does not receive video bytes or pretend an omitted item was inspected. An album with no readable images fails visibly instead of becoming an image-free retry of its caption.

## Download and private storage

Commit the accepted source descriptors and polling cursor together, before downloading. The owned worker claims pending attachments separately from generation. It calls `getFile`, validates the returned relative path, and downloads bytes only from Telegram's fixed HTTPS file origin with redirects rejected. The token-bearing download URL is never stored, logged, included in a prompt, or returned to the browser. Retry obtains a fresh file path from the durable file ID.

Each image is limited to 5 MiB, at most 8,192 pixels on either axis and 32 million pixels. Inspect file signatures/dimensions instead of trusting the filename or Telegram MIME declaration. JPEG, PNG and WebP are the only accepted representations; this is structural validation rather than a full pixel decode. Both advertised sizes and streamed byte counts are bounded, and downloads have a total deadline. Rate limits and transient failures use bounded retries; interrupted reads are recoverable and do not resend a completed reply.

Store original downloaded bytes once in a private SQLite attachment record, with MIME, dimensions, size, SHA-256 and source provenance. The production database is outside Git. Ready attachment data is immutable. A prompt snapshot retains attachment IDs and content hashes rather than copying base64 into every turn. Only validated ready attachments can be fetched by the private dashboard preview endpoint, under the existing exact host/origin checks and no-store response policy.

## Model input and context

Authenticated Neuralwatt discovery verifies vision support and per-request image limits. `glm-5.3-flash` currently supports vision and advertises twenty images, so this feature does not switch Valerie's model. A live fictional image probe verified multipart `image_url` parts carrying a base64 PNG data URI. See [Neuralwatt model metadata](https://docs.neuralwatt.com/api/models) and [message content arrays](https://docs.neuralwatt.com/api/chat-completions); the exact data-URI shape was also validated directly against the selected model.

Once the current images are ready and the album is settled, capture one coherent prompt/settings/history snapshot. Compose each original caption with its associated image, preserving source order and Post-History Instructions after the conversation. The server resolves pinned local image references into inline data URIs immediately before inference. Never pass Telegram URLs, arbitrary remote image URLs, or local filesystem paths to Neuralwatt.

The inference request accepts at most 5 MiB per image, 16 MiB decoded image bytes total, twenty images or the model's smaller verified limit, and 24 MiB serialized request JSON. Base64 is not counted as prose. Context budgeting reserves an 8,192-token allowance per image; this is a heuristic, not an exact provider token count. Actual usage is recorded separately.

Current images take priority. Up to four recent historical images can accompany them within the count, byte, age, and context budgets. Older image bytes remain archived; omitted images get an explicit marker in the prompt while their caption and delivered reply can remain as text history. Valerie is instructed not to claim she sees an image that was omitted. No automatic visual memory, image summaries, or old-topic retrieval are introduced.

## Verification

Fictional tests cover photo/document selection, captions, owner filtering, split-batch albums, duplicate updates, download limits/redirects/deadlines, safe URL handling, media validation, immutable private storage, restart recovery, coherent image snapshots, history omissions, inference payloads and protected previews. A live synthetic image checks the exact selected model's visual understanding without disclosing user images.

Telegram input/download semantics: [getUpdates, Message, PhotoSize and getFile](https://core.telegram.org/bots/api).
