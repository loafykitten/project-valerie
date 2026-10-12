# macOS desktop VRM, emotion, and synchronized speech

Status: development specification, after the homelab conversation service is useful. Research checked 2026-09-11. Depends on authenticated server events, shared speech assets, expression metadata, and a user-supplied VRM/animation set. **macOS first** is confirmed; no particular model asset or target Mac performance has been verified.

## Desktop technology choice

Use Electron with a small Three.js/`@pixiv/three-vrm` renderer for the first spike. Three-vrm supplies VRM loading through a GLTFLoader plugin and a VRM runtime. Keep a WebGL baseline until actual rendering/performance requires WebGPU; the project's WebGPU notes describe additional material/version compatibility concerns. [three-vrm](https://github.com/pixiv/three-vrm).

| Option | Relevant capability / tradeoff | Decision |
| --- | --- | --- |
| Electron | Documented transparent frameless windows and explicit mouse-event ignoring; shared TypeScript/Chromium stack, larger runtime footprint | First implementation; prove macOS interaction early |
| Tauri | Uses an OS webview and Rust shell; macOS transparent background needs `macOSPrivateApi` | Viable personal-use alternative if footprint matters enough to justify Rust/WebKit-specific work |
| Native AppKit + web renderer | Fine window control, but another integration layer and native code | Revisit if Electron cannot meet tested Spaces/focus/energy needs |

Electron's transparent pixels do not automatically pass clicks through. Draggable CSS regions are rectangular and ignore pointer events. `setIgnoreMouseEvents` can forward mouse movement on macOS, which can support hit testing, but it does not solve the entire model-shaped interaction automatically. Tauri's private-API requirement is documented; evaluate distribution implications if it becomes the chosen shell. [Electron styles](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles), [Electron interactions](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions), [Tauri configuration](https://v2.tauri.app/reference/config/#macosprivateapi).

The desktop shell uses Electron's runtime; the homelab server and workspace tooling use Bun. Do not force Electron main-process code to run as a Bun daemon. The desktop carries no Telegram/Neuralwatt/ElevenLabs credentials. It authenticates as one device to the server and caches only necessary local assets.

## Window and interaction behavior

Create a transparent, frameless, initially fixed-size window with alpha canvas and no page background. Keep the window footprint close to the avatar. Model scaling changes camera/render scale; transparent native-window resizing should be tested before relying on it. Save last safe display/work-area position and scale. Offer visible menu-bar controls to show/hide, center, scale, mute, lock position, and quit, so a misplaced or click-through avatar is recoverable.

Implement a bounded screen-space hit test around the rendered avatar or projected interaction mesh. Set the window to ignore events in empty areas; enable pointer handling over the avatar. Latch interaction on mouse-down so moving across an empty area does not drop a drag. Use a drag-distance threshold to distinguish a click from dragging. Update bounds through a narrow validated IPC method, clamped to a reachable display area; do not expose general native APIs to the renderer.

The first spike must test click-through to apps below, grabbing while another app is active, fast movement, mouse-up outside the window, display scale changes, multiple monitors, Mission Control/Spaces/fullscreen behavior, sleep/wake, and a display unplug. “Always on top” should be user-configurable and should not continually steal focus. A transparent companion is not a global desktop-control tool.

Use context isolation, sandboxing, no Node integration in the renderer, a restricted preload API, local bundled UI/assets, CSP, and navigation/external-link checks. Validate IPC sender and arguments. Those controls protect a desktop shell that displays remotely generated content. [Electron security](https://www.electronjs.org/docs/latest/tutorial/security).

## Avatar assets and animation

`avatar_profile` holds asset hash/license reference, VRM version, expression mapping revision, scale/camera settings, available animation IDs, and performance settings. Check VRM metadata, load failures, missing bones/expression names, texture size, and animation retargeting. Preserve the original asset; transformations are derived runtime/configuration choices.

Use a layered mixer: base idle/breathing and subtle gaze/blink, optional gesture, emotion expression, and speech mouth movement. Use frame delta, smooth transitions, and caps on overlapping weights. Avoid an animation restarting on every token or expression-classifier update. Map a small named animation library (`idle`, `greeting`, `thinking`, `listening`, `speaking`, configured gestures), not freeform animation code generated by the model.

VRM 1.0 uses expressions such as `happy`, `sad`, `relaxed`, `surprised` and vowel presets `aa`, `ih`, `ou`, `ee`, `oh`, with override behavior affecting lips/blink. An adapter must handle VRM 0.x naming and custom expressions instead of assuming one naming convention. Honor model override semantics to avoid forcing a smile and lip sync to distort the mouth together. [VRM expression specification](https://vrm.dev/en/vrm1/expression/).

## Emotion as expressive state

SillyTavern's expressions can classify the generated reply and select a corresponding image, with local or LLM classification and custom labels. This is a useful inspiration for output presentation, but a classifier's label should not become proof of a persistent internal feeling. [SillyTavern expressions](https://docs.sillytavern.app/extensions/expression-images/).

Valerie's emotion feature has two separate roles: a light pre-turn expressive state can color wording, and a per-response presentation plan chooses expression, delivery, and gestures. Start with a small configurable set such as neutral, warm, playful, thoughtful, concerned, and pleased. Map these onto whatever the actual VRM and voice support. Labels are settings, not text that must appear in the chat.

```ts
type ExpressionPlan = {
  turnId: string;
  revision: number;
  label: string;
  intensity: number; // clamped 0..1
  transitionMs: number;
  gestureId?: string;
  speechCue?: string;
  expiresAt: string;
};
```

Prefer generating a validated sidecar alongside the final response if the selected model reliably supports it; otherwise classify the completed response asynchronously or use neutral. Classification is bounded and must not delay text delivery. Never require visible `[happy]` tags or reformat all messages as quoted speech. A classification error falls back to neutral, not a regenerated personality answer.

If a persistent mood is added, it must decay toward neutral, be inspectable/resettable, and never override Ember's explicit preferences, task truth, or reminder timing. A delayed reply must not automatically escalate anxiety/anger, guilt, dependency claims, or nagging. Keep the source card's relationship dynamic unchanged; this system colors performance, not the terms of the relationship.

## Audio and synchronization

The server produces a speech asset and presentation metadata; the client acknowledges receipt and playback stages. Character alignment from ElevenLabs maps text to audio, not phonemes/visemes. Start with amplitude-driven jaw/mouth opening, a noise gate, smoothing, and decay to closed during silence. Use alignment for segment/highlight timing when useful. Higher-fidelity phoneme/viseme generation is a separate measured quality improvement. [ElevenLabs timing](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps).

Clock all local mouth/expression cues against actual audio playback time, not request start or network arrival. Decode/load first; schedule animation with the audio context/playback timeline and reconcile after pause/resume. On stop, interruption, completion, decode failure, or disconnect, fade speech shapes to neutral. Chunked speech later needs monotonic sequence IDs and no gap/overlap assumptions; whole-response playback is the simpler initial proof.

Use an authenticated WebSocket for server events and client acknowledgments:

```ts
type DesktopEvent = {
  id: string;
  sequence: number;
  type: "expression" | "speech.ready" | "speech.cancel" | "presence";
  turnId?: string;
  payload: unknown;
  expiresAt: string;
};
```

Reconnect with the last received sequence; distinguish received from played. Deduplicate utterances and do not replay a backlog of old speech after the Mac wakes. A live desktop device/presence policy determines whether to speak locally, send Telegram, or both as explicitly configured. Choosing “both” is intentional; an offline desktop is not a reason to unexpectedly deliver every local utterance to Telegram.

## Acceptance and rollout

1. Prove an ordinary transparent object can be dragged/clicked while surrounding pixels pass through on Ember's Mac; verify recovery controls and no focus theft.
2. Load the actual VRM, inspect expressions and mixed poses, test idle/gesture blending, and measure frame time/CPU/GPU use during a representative session. Target 30 fps idle with an optional 60 fps setting; cap background/hidden rendering. Targets require measurement, not assumed performance.
3. Play a fixed audio fixture and verify silent mouth closure, pause/stop recovery, and a proposed perceptual sync target within roughly 100 ms. Use recordings/visual review, not only event timestamps.
4. Connect a real synthesized reply, ensure TTS cues stay out of text, and verify neutral fallback for unknown expression labels.
5. Test reconnect/sleep/wake, duplicate events, cancelled speech, unavailable assets, and audio-device changes. No backlog playback or frozen open mouth.
6. Package/notarize only after the native interaction spike passes. A browser rendering test does not establish macOS desktop behavior.
