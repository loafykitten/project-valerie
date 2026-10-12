# Valerie on macOS — planned client

This is a documented future boundary, not an implemented desktop application. Start after the conversational MVP is useful.

The first spike will use Electron + Three.js + `@pixiv/three-vrm`: a transparent, draggable macOS window, controlled click-through, idle animation, VRM expressions, and audio-clock-driven lip movement. Keep rendering and desktop permissions here; the Bun service remains on homelab. Do not ship provider secrets to the renderer.

See [desktop, VRM, and emotion design](../../docs/features/desktop-vrm-emotion.md) for platform tradeoffs, acceptance criteria, and synchronization contracts. Do not add Electron dependencies until beginning that spike.
