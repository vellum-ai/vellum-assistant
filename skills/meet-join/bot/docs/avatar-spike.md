# Avatar Renderer Evaluation Spike

## Status

**Design doc (pre-spike).** The numbers below are **expected based on vendor
documentation and published benchmarks**, not measured against live
prototypes. A follow-up refresh will replace these estimates with measured
values once PR 5a's TalkingHead.js prototype is running end-to-end (screen
recording will be linked from the PR 5a description).

Why pre-spike: the renderer interface and device-passthrough plumbing
(PRs 1-5) are independent of which backend ships first, and the v1 default
is already constrained to "OSS, no paid deps, runs on any Linux host" —
which has exactly one realistic answer. Blocking the whole phase on a
spike that can only confirm the obvious choice is not worth the delay.
Post-spike measurements still matter for the non-default renderers (they
inform when operators should prefer each backend) and will be folded back
into this doc as the additive PRs land.

## Evaluation rubric

Each renderer is scored across five axes:

- **Latency** — end of TTS chunk → corresponding mouth-movement frame
  available on `/dev/video10`. Target for v1 is <400ms, tightened to
  <150ms by PR 9's playback-timestamp alignment for viseme-driven
  renderers only. Hosted and GPU-sidecar renderers handle
  audio-to-motion timing server-side and are out of scope for PR 9.
- **Fidelity** — subjective visual quality plus whether frames stutter
  or drop. A "uncanny but smooth" renderer beats a "photoreal but
  jittery" one for meeting use.
- **Operational cost** — per-meeting $ for hosted APIs; container
  RAM/CPU/GPU for self-hosted. Meetings are assumed 30 min average.
- **Integration complexity** — number of moving parts, whether
  v4l2loopback plugs in cleanly, whether a second Chrome tab is
  required, whether a separate sidecar container is required.
- **Input expectations** — what the renderer consumes (visemes? raw
  audio? a reference image?). Drives the `AvatarCapabilities`
  declaration on the concrete `AvatarRenderer`.

## Comparison matrix

| Renderer | Latency (expected) | Fidelity | Op. cost | Complexity | Input (`capabilities`) |
| --- | --- | --- | --- | --- | --- |
| **TalkingHead.js** (OSS, WebGL) | 80-200ms in-browser once the GLB is loaded; add <50ms for the native-messaging hop to the bot and JPEG→Y4M transcode. Playback-timestamp alignment (PR 9) pulls sustained drift under 150ms. | Good for "virtual assistant" aesthetics with Ready Player Me avatars. Blendshape-driven lips look clearly animated but are obviously stylized; no photorealism. Frame rate should hold at 24-30fps on a modern CPU with no GPU required. | $0 (runs in-process in a second Chrome tab opened by the extension). Memory: ~150-300 MB extra Chrome-tab RSS. CPU: 1 core at 30-50% sustained. | **Low-medium.** One second Chrome tab via `chrome.tabs.create`; frames captured with `canvas.captureStream` / `toBlob`; native-messaging round-trips for visemes-in, frames-out. No sidecar, no paid API, no GPU. Adds a JPEG→Y4M ffmpeg child on the bot side. | `{ needsVisemes: true, needsAudio: true }` — visemes drive blendshapes; audio feeds amplitude fallback. |
| **Simli** (hosted WebRTC) | ~150-300ms end-to-end per vendor docs (audio upload → WebRTC video track back), dominated by their server-side inference. No PR 9 alignment needed. | High. Photoreal-ish preset avatars; smoother lips than TalkingHead.js because motion is generated from audio server-side. Frame rate 25-30fps per their docs. | Hosted, per-minute billing (mid single-digit $ / hr as of last public pricing — verify at integration time). External dependency on the Simli API; paid key required. | **Medium.** Second Chrome tab to host the WebRTC session; renderer pushes PCM through a data channel and captures the inbound video track via CDP `Media.startCapture` (or `chrome.desktopCapture`). No GPU, no sidecar, but adds a paid credential and network dependency. | `{ needsVisemes: false, needsAudio: true }` — audio only. |
| **HeyGen** (hosted WebRTC) | ~200-400ms expected per their real-time streaming docs; similar shape to Simli. | Very high. HeyGen's streaming avatars are the current state of the art for per-minute-priced hosted renderers. | Hosted, per-minute billing (roughly HeyGen's "Interactive Avatar" credits; tiered, currently expensive at volume). Paid API key; quota ceilings apply. | **Medium**, identical to Simli's shape — second Chrome tab + WebRTC + paid credential. | `{ needsVisemes: false, needsAudio: true }`. |
| **Tavus** (hosted WebRTC) | ~250-500ms expected per their docs; they emphasize persona customization over raw latency. | High. Good lip-sync; tuned for long-form conversational AI rather than burst-mode TTS, so audio chunking matters. | Hosted, per-minute billing, paid API key. Tiered pricing similar to HeyGen. | **Medium**, identical shape to Simli / HeyGen. | `{ needsVisemes: false, needsAudio: true }`. |
| **SadTalker** (GPU sidecar) | ~800-1500ms expected on a single modern NVIDIA GPU (T4 / L4 / 3060-class) — the model is batch-oriented and operates on full utterance chunks rather than streaming. | High for short-form utterances; can look uncanny on long ones. Frame rate is whatever the GPU produces, usually 15-25fps depending on resolution. | Self-hosted but requires an NVIDIA GPU. Container RAM: ~6-10 GB VRAM; CPU: 2 cores; a beefy GPU sidecar costs real money to run 24/7 if not sized per-meeting. | **High.** Separate sidecar container launched by `MeetSessionManager` when the renderer is configured; HTTP streaming between bot and sidecar; Y4M frame transport. Reference portrait asset committed. Requires GPU host. | `{ needsVisemes: false, needsAudio: true }` — audio plus a static reference image. |
| **MuseTalk** (GPU sidecar) | ~300-600ms expected — newer model with better streaming characteristics than SadTalker; designed for real-time. | Very high. MuseTalk publishes the strongest lip-sync numbers in the open-source space as of late 2024. Frame rate ~25-30fps on a 3090-class GPU. | Self-hosted, GPU required (≥8 GB VRAM in streaming mode). Container RAM: ~8-12 GB VRAM; sidecar cost comparable to SadTalker but with real-time responsiveness. | **High.** Same shape as SadTalker's sidecar. Slightly more complex model bootstrapping (reference face encoding step) but otherwise mirrors SadTalker's integration. | `{ needsVisemes: false, needsAudio: true }`. |

## V1 default recommendation: **TalkingHead.js**

TalkingHead.js ships enabled by default in PR 5a because it is the only
candidate that simultaneously satisfies all v1 constraints:

- **OSS, no paid dependencies.** MIT-compatible license; no API keys, no
  per-minute costs, no quota ceilings.
- **Runs on any Linux host.** No GPU required. CPU-only rendering via
  WebGL inside an offscreen Chrome tab opened by the
  `meet-controller-ext`. Works on the same hardware the rest of Phase
  1-3 targets.
- **Browser-native.** Integrates cleanly with the existing post-Phase-1.11
  architecture — no new runtime, no new language. The extension
  already owns tab lifecycle and native-messaging transport; the
  avatar flow reuses both.
- **GLB avatars are widely available.** Ready Player Me hands users a
  free, customizable glTF/GLB avatar in under a minute; swapping the
  bundled default is a config-only change
  (`services.meet.avatar.talkingHead.modelPath`).
- **Quality is acceptable for an assistant.** The "virtual assistant"
  aesthetic matches participant expectations better than an uncanny
  photoreal attempt would — hosted renderers look more realistic but
  their failure modes (audio glitches during server outages,
  rate-limit drops mid-meeting) are worse for a persistent
  camera-on experience.
- **Upgrade path is clean.** Operators who want a higher-fidelity
  renderer flip one config value; no code changes, no redeploy of the
  bot image. Because PR 5 establishes the registry first, PR 5a
  through PR 5d are all additive.

The v1 latency target (<400ms) is comfortably achievable; the stricter
<150ms target lands with PR 9's playback-timestamp alignment and applies
only to renderers that consume visemes (TalkingHead.js being the only
one on the current list).

### V1 prototype status

**Not yet demonstrated.** The prototype will happen during PR 5a's
implementation — this doc will be refreshed with real latency/fidelity
measurements, and a screen recording link will be added to the PR 5a
description. The comparison-matrix numbers above are all labelled
"expected" rather than "measured" to make that status explicit.

## Per-renderer integration notes

Each non-default renderer is a purely additive PR after PR 5 lands. The
shape is identical in every case:

1. Implement a single file at
   `skills/meet-join/bot/src/media/avatar/<renderer-id>/renderer.ts`
   that implements the `AvatarRenderer` interface from PR 1.
2. Register the renderer at module import time via
   `registerAvatarRenderer("<id>", factory)` from PR 5's registry.
3. Extend `services.meet.avatar.renderer` in
   `skills/meet-join/config-schema.ts` with the new id, and add an
   optional per-renderer options block (credentialId, assetPath,
   etc.) — the schema is already designed to grow this way.
4. Add credential resolution in
   `skills/meet-join/daemon/session-manager.ts` so the credential value
   is threaded into the bot container's env at spawn time (the bot
   cannot access the vault directly).
5. Unit-test the renderer using the in-memory fake from PR 1 as a
   reference for the interface, plus backend-specific mocks for the
   HTTP/WebRTC surface.

No edits to any existing consumer of the interface are required — the
registry discovery pattern isolates the rest of the codebase from each
backend's specifics.

### TalkingHead.js — PR 5a

- **Status:** scheduled as PR 5a (must-ship for v1).
- **Blockers:** none. Requires only the PR 5 registry and PR 3's Chrome
  camera flag, both of which are already in the wave plan.
- **Unique moving parts:** a second Chrome tab opened by the
  `meet-controller-ext` via `chrome.tabs.create`, a bundled
  `default-avatar.glb`, and JPEG→Y4M transcoding via a short-lived
  ffmpeg child on the bot side.
- **Follow-up:** PR 9 adds playback-timestamp alignment specifically
  for this renderer (and any future viseme-consuming renderer).

### Simli — PR 5b

- **Status:** additive, lands whenever an operator requests Simli
  support.
- **Blockers:** requires a paid Simli API key in the credential vault
  (`simli.apiKeyCredentialId`). Without a key, the renderer throws
  `AvatarRendererUnavailableError` at construction time.
- **Unique moving parts:** a minimal local HTML page hosted inside a
  second Chrome tab that establishes the Simli WebRTC session; CDP
  `Media.startCapture` (or `chrome.desktopCapture`) to grab the
  inbound video track; PCM pushed through the data channel.
- **Notes:** ignores visemes; the server-side pipeline is audio-to-
  video end-to-end, so PR 9's alignment work is inert here.

### HeyGen — PR 5c

- **Status:** additive, lands whenever an operator requests HeyGen
  support.
- **Blockers:** HeyGen Interactive Avatar API key, provisioned via the
  same credential-vault path as Simli. HeyGen's account tier gates
  which avatars are available — document the selection in the PR
  description.
- **Unique moving parts:** HeyGen's session-start / session-stop /
  heartbeat semantics need explicit handling; propagate their errors
  as `AvatarRendererUnavailableError` at the matching lifecycle
  points so the bot can fall back to noop instead of crashing.

### Tavus — PR 5d-alt (not yet in wave plan)

- **Status:** not currently scheduled; added to this doc for
  completeness. When an operator requests Tavus, the PR mirrors the
  shape of Simli / HeyGen exactly.
- **Blockers:** Tavus API key. Tavus personas are heavier to
  configure than Simli's preset avatars, so the PR will need a
  `services.meet.avatar.tavus.personaId` config surface in addition
  to the credential reference.
- **Unique moving parts:** Tavus chunks audio differently than Simli
  or HeyGen — small utterance fragments can hit silence-detection
  timeouts on their side. The bot needs to either batch TTS chunks
  to a sensible size or hold the WebRTC session open with a silent-
  audio keepalive.

### SadTalker — PR 5d

- **Status:** additive, scheduled as PR 5d in the wave plan.
- **Blockers:** requires an NVIDIA GPU host and a pre-built sidecar
  container image. In Docker mode (Phase 1.10 DinD), the sidecar
  runs inside the daemon container's inner dockerd; in bare-metal
  mode, it runs as a sibling container on the host's Docker engine.
  Both modes assume a GPU is attached.
- **Unique moving parts:** `MeetSessionManager` conditionally
  launches the sidecar container alongside the bot; HTTP streaming
  transport for PCM-in and Y4M-out; reference portrait asset
  (`default-portrait.jpg`) committed and overridable.
- **Notes:** highest latency of any candidate (~1s). Renderer throws
  `AvatarRendererUnavailableError` at `start()` time if the sidecar
  is unreachable — meetings must not silently fall back when
  SadTalker was explicitly requested.

### MuseTalk — future PR (not yet scheduled)

- **Status:** not in the current wave plan; added to this doc because
  it is the strongest open-source GPU-sidecar option as of late 2024
  and will likely be the next renderer requested after SadTalker.
- **Blockers:** NVIDIA GPU host (≥8 GB VRAM for streaming mode). The
  sidecar image is heavier than SadTalker's — budget extra disk for
  the pre-trained weights.
- **Unique moving parts:** MuseTalk requires a reference-face
  encoding step at sidecar startup, which slows the first meeting's
  avatar-enable by ~30s. Subsequent meetings against the same
  reference image reuse the cached embedding. Worth surfacing a
  "warming up" state in the daemon's avatar tool so the LLM can
  explain the delay to users.

## Summary

Ship TalkingHead.js as the v1 default (PR 5a). Land Simli, HeyGen, and
SadTalker as additive, credential-gated alternatives (PR 5b / 5c / 5d)
that operators can flip on via config. Treat Tavus and MuseTalk as
post-v1 follow-ups that mirror the Simli and SadTalker integrations
respectively. Refresh this doc with measured latency and a PR 5a screen
recording once the default renderer is running end-to-end.
