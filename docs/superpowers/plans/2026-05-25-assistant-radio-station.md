# Assistant Radio Station Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the smallest useful assistant radio slice: a feature-flagged, tiny expandable composer pill in the web chat UI that plays backend-owned demo tracks, asks the assistant to choose the next track and write a short DJ break, synthesizes that break through existing `services.tts`, and guides beta users to Settings -> AI when TTS is not configured.

**Architecture:** The assistant runtime owns the track catalog, station state, DJ planning, TTS synthesis, and static audio routes. The web app owns playback timing, progress, ducking, crossfade, and the composer pill. The UI feature flag hides or shows only the composer pill; the backend route remains available for the first slice.

**Tech Stack:** Bun, TypeScript, assistant route definitions, existing LLM provider abstraction, existing TTS abstraction, React, Zustand, TanStack/HeyAPI client, Tailwind, Vellum design library, lucide-react.

---

## Scope Check

This plan touches both `assistant/` and `apps/web/`, but keeps the slice narrow:

- No callers, queue, presence, SSE, durable listening sessions, Spotify, or external music search.
- No cleanup of browser-local TTS settings beyond linking to `/assistant/settings/ai`.
- No deterministic news, sports, or local context provider. The DJ model may use web tools from its own prompt-driven judgement.
- No backend feature-flag enforcement for `radio/advance`; only the composer pill is gated.

One notable implementation tweak from the design spec: backend responses should return assistant-runtime-relative audio paths such as `radio/tracks/soft-launch` and `audio/<audioId>`. The web adapter derives the browser URL as `/v1/assistants/{assistantId}/{path}` so audio works through the existing gateway proxy.

## File Map

Backend files to add:

- `assistant/src/radio/types.ts`
- `assistant/src/radio/catalog.ts`
- `assistant/src/radio/station-state.ts`
- `assistant/src/radio/dj-planner.ts`
- `assistant/src/radio/radio-tts.ts`
- `assistant/src/radio/assets/soft-launch.wav`
- `assistant/src/radio/assets/buffer-bloom.wav`
- `assistant/src/radio/assets/neon-postcard.wav`
- `assistant/src/radio/scripts/generate-demo-tracks.ts`
- `assistant/src/radio/__tests__/catalog.test.ts`
- `assistant/src/radio/__tests__/dj-planner.test.ts`
- `assistant/src/radio/__tests__/radio-tts.test.ts`
- `assistant/src/runtime/routes/radio-routes.ts`
- `assistant/src/runtime/routes/__tests__/radio-routes.test.ts`

Backend files to edit:

- `assistant/src/runtime/routes/index.ts`
- `assistant/src/config/schemas/llm.ts`
- `assistant/src/config/call-site-defaults.ts`
- `assistant/src/config/schemas/call-site-catalog.ts`
- `assistant/src/__tests__/llm-callsite-catalog.test.ts`

Feature flag files to edit:

- `meta/feature-flags/feature-flag-registry.json`
- `apps/web/src/lib/feature-flags/feature-flag-registry.json`, via sync script
- `assistant/src/config/feature-flag-registry.json`, via sync script
- `meta/feature-flags/PENDING_PLATFORM_PRS.md`

Web files to add:

- `apps/web/src/domains/radio/types.ts`
- `apps/web/src/domains/radio/api.ts`
- `apps/web/src/domains/radio/audio-controller.ts`
- `apps/web/src/domains/radio/radio-store.ts`
- `apps/web/src/domains/radio/radio-composer-pill.tsx`
- `apps/web/src/domains/radio/audio-controller.test.ts`
- `apps/web/src/domains/radio/radio-store.test.ts`
- `apps/web/src/domains/radio/radio-composer-pill.test.tsx`

Web files to edit:

- `apps/web/src/domains/chat/components/chat-composer/chat-composer.tsx`
- `apps/web/src/domains/chat/components/chat-composer/chat-composer.test.tsx`
- `apps/web/src/domains/chat/components/chat-route-content.tsx`

## Task 1: Add The Rollout And LLM Tracking Seams

- [ ] Add `radioDj` to `LLMCallSiteEnum` in `assistant/src/config/schemas/llm.ts`.
- [ ] Add `radioDj: { profile: "balanced" }` to `CALL_SITE_DEFAULTS` in `assistant/src/config/call-site-defaults.ts`.
- [ ] Add a catalog entry in `assistant/src/config/schemas/call-site-catalog.ts`:
  - display name: `Radio DJ`
  - description: `Chooses radio tracks and writes short spoken DJ breaks.`
  - domain: `ui`
- [ ] Add one named assertion to `assistant/src/__tests__/llm-callsite-catalog.test.ts` that verifies `radioDj` is labeled `Radio DJ` and uses the `ui` domain.
- [ ] Run the call-site coverage test and confirm it fails before the enum/default/catalog implementation is complete:

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd assistant
bun test src/__tests__/llm-callsite-catalog.test.ts
```

- [ ] Add the `assistant-radio` assistant feature flag to `meta/feature-flags/feature-flag-registry.json` with `defaultEnabled: false`, label `Assistant Radio`, and a description that says it controls the web composer radio pill.
- [ ] Run the feature-flag sync script:

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run meta/feature-flags/sync-bundled-copies.ts
```

- [ ] Add an entry to `meta/feature-flags/PENDING_PLATFORM_PRS.md` noting that `assistant-radio` needs the companion LaunchDarkly/Terraform platform flag.
- [ ] Verify:

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd assistant
bun test src/__tests__/llm-callsite-catalog.test.ts
```

## Task 2: Add A Licensed Demo Track Catalog

- [ ] Create `assistant/src/radio/scripts/generate-demo-tracks.ts`. It should deterministically generate three mono 16-bit PCM WAV files at 22,050 Hz, 18 seconds each, using simple oscillator layers and amplitude envelopes. Do not fetch external audio.
- [ ] Generate these assets:
  - `assistant/src/radio/assets/soft-launch.wav`
  - `assistant/src/radio/assets/buffer-bloom.wav`
  - `assistant/src/radio/assets/neon-postcard.wav`
- [ ] Create `assistant/src/radio/types.ts` with exported types:
  - `RadioAdvanceReason = "start" | "song_ended" | "skip" | "retry"`
  - `RadioDisplayCue = "song" | "dj" | "transition" | "setup_needed" | "error"`
  - `RadioTrack`
  - `RadioAdvanceRequest`
  - `RadioAdvanceResponse`
  - `RadioPlaybackPlan`
- [ ] Create `assistant/src/radio/catalog.ts` with a frozen `RADIO_TRACKS` list. Each track must include `id`, `title`, `artist`, `durationMs`, `assetPath`, `audioPath`, `sourceLabel`, `license`, and `sha256`.
- [ ] Add helpers `listRadioTracks()`, `getRadioTrack(id)`, and `pickFallbackTrack({ currentTrackId, recentTrackIds })`.
- [ ] Add `assistant/src/radio/__tests__/catalog.test.ts` first, covering:
  - track ids are unique
  - every asset exists
  - every checksum matches
  - every license is `repo-generated`
  - fallback never picks the current track when alternatives exist
- [ ] Generate assets and fill checksums:

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd assistant
bun run src/radio/scripts/generate-demo-tracks.ts
shasum -a 256 src/radio/assets/*.wav
```

- [ ] Verify:

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd assistant
bun test src/radio/__tests__/catalog.test.ts
```

## Task 3: Implement DJ Planning With A Tool-Capable Micro Loop

- [ ] Create `assistant/src/radio/dj-planner.ts`.
- [ ] Do not use `runBtwSidechain`, because it forces `tool_choice: { type: "none" }`.
- [ ] Implement `planRadioDjBreak(params, deps?)` using `getConfiguredProvider("radioDj")`.
- [ ] Send a compact system prompt that asks the model to:
  - choose exactly one `nextTrackId` from provided track candidates
  - write one spoken DJ break under 55 words
  - return JSON only: `{ "nextTrackId": string, "djText": string }`
  - use `web_search` or `web_fetch` only when timely context would make the break better
- [ ] Include only `webSearchTool.getDefinition()` and `webFetchTool.getDefinition()` in the provider call.
- [ ] Implement a bounded micro loop for up to three provider calls:
  - call `provider.sendMessage(messages, tools, systemPrompt, { config: { callSite: "radioDj" }, signal })`
  - if the response contains normal `tool_use` blocks for `web_search` or `web_fetch`, execute only those two imported tool instances directly with a `ToolContext` containing `conversationId: "radio"`, `workingDir: getWorkspaceDir()`, the loop `requestId`, the request `signal`, `allowedToolNames: new Set(["web_search", "web_fetch"])`, `trustClass: "guardian"`, and `executionChannel: "vellum"`; append `tool_result` blocks and continue
  - if the provider uses native server-side web search, let the provider return final text normally
  - reject any other tool name with an error `tool_result`
  - stop on final text and validate the JSON with zod
- [ ] Keep this wrapper side-effect free except for optional network search/fetch. It must not persist conversation messages and must not register new tools.
- [ ] Add `assistant/src/radio/__tests__/dj-planner.test.ts` first, covering:
  - `getConfiguredProvider` is called with `radioDj`
  - a valid JSON response is parsed
  - invalid track ids are rejected
  - malformed JSON falls back through a typed error path
  - normal `web_search` tool_use results are executed and fed back into the next provider call
  - unexpected tool names are returned as error tool results
- [ ] Verify:

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd assistant
bun test src/radio/__tests__/dj-planner.test.ts
```

## Task 4: Add Radio TTS And Advance Routes

- [ ] Create `assistant/src/radio/radio-tts.ts`.
- [ ] Implement `synthesizeRadioDjBreak(text, signal?)` using:
  - `sanitizeForTts(text)`
  - `synthesizeText({ text: sanitized, useCase: "message-playback", signal })`
  - `storeAudio(buffer, format)` from `assistant/src/calls/audio-store.ts`
- [ ] Add `audioFormatFromContentType(contentType)` mapping:
  - `audio/mpeg` and `audio/mp3` -> `mp3`
  - `audio/wav` and `audio/wave` -> `wav`
  - `audio/opus` -> `opus`
  - `audio/pcm` -> `pcm`
  - unknown content type -> `mp3`
- [ ] Map `TTS_PROVIDER_NOT_CONFIGURED` to a structured setup response with reason `tts_not_configured` and settings path `/assistant/settings/ai`.
- [ ] Create `assistant/src/radio/station-state.ts` with module-local state:
  - current segment id
  - current track id
  - recent track ids, capped at 5
  - last generated DJ text
- [ ] Create `assistant/src/runtime/routes/radio-routes.ts` with:
  - `POST radio/advance`
  - `GET radio/tracks/:trackId`
- [ ] `POST radio/advance` behavior:
  - `start`: return an initial track with `displayCue: "song"` and no DJ break
  - `song_ended` or `skip`: call `planRadioDjBreak`, validate the model-chosen track, synthesize DJ audio, update station state, and return `displayCue: "transition"`
  - planner failure: fall back to `pickFallbackTrack`, return short deterministic DJ copy, and still try TTS
  - TTS missing or auth/provider failure: return `displayCue: "setup_needed"` with `setup.settingsPath: "/assistant/settings/ai"` and the chosen next track
  - stale `segmentId`: return the current state without mutating if the request is not `start`
- [ ] `GET radio/tracks/:trackId` should read the committed WAV asset and return `Uint8Array` with `Content-Type: audio/wav` and a long-lived immutable cache header.
- [ ] Register `RADIO_ROUTES` in `assistant/src/runtime/routes/index.ts`.
- [ ] Add `assistant/src/runtime/routes/__tests__/radio-routes.test.ts` first, covering:
  - start response shape and playable `track.audioPath`
  - transition response includes `djBreak.text`, `djBreak.audioPath`, and playback plan
  - missing TTS returns `setup_needed`
  - invalid planner track id recovers to fallback
  - stale segment request does not advance station state
  - track route returns WAV bytes and `audio/wav`
- [ ] Verify:

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd assistant
bun test src/radio/__tests__/radio-tts.test.ts src/runtime/routes/__tests__/radio-routes.test.ts
```

## Task 5: Add Web Radio API, Playback Controller, And Store

- [ ] Create `apps/web/src/domains/radio/types.ts` mirroring the backend response types, using `audioPath` in API payloads and resolved `audioUrl` in store state.
- [ ] Create `apps/web/src/domains/radio/api.ts` with:
  - `advanceRadio(assistantId, request)`
  - `runtimeAudioUrl(assistantId, audioPath)`
  - `RADIO_TTS_SETTINGS_PATH = routes.settings.ai`
- [ ] Use the generated `client.post` pattern with URL `/v1/assistants/{assistant_id}/radio/advance/`.
- [ ] Create `apps/web/src/domains/radio/audio-controller.ts`.
- [ ] The controller should accept injected audio factories for tests and real `new Audio(url)` in production.
- [ ] Implement:
  - `playInitial(track)`
  - `pause()`
  - `resume()`
  - `skip()`
  - `applyTransition({ outgoingTrack, djBreak, nextTrack, playbackPlan })`
  - volume ramp helper using `requestAnimationFrame`
  - `onProgress` callback with `positionMs` and `remainingMs`
  - `onTrackEnding` callback fired once when remaining time is below the prefetch window
  - `onTrackEnded` callback for non-prefetched endings
- [ ] Create `apps/web/src/domains/radio/radio-store.ts` using Zustand. State should include:
  - `status: "idle" | "loading" | "playing" | "paused" | "transitioning" | "setup_needed" | "error"`
  - `displayCue`
  - `isExpanded`
  - `isHidden`
  - `currentTrack`
  - `nextTrack`
  - `djText`
  - `progressMs`
  - `remainingMs`
  - `setup`
  - `errorMessage`
- [ ] Store actions should include `start(assistantId)`, `pause()`, `resume()`, `skip(assistantId)`, `retry(assistantId)`, `toggleExpanded()`, `hide()`, and `show()`.
- [ ] Add tests first:
  - `audio-controller.test.ts` verifies ducking/fade instructions and event callbacks with fake audio objects
  - `radio-store.test.ts` verifies start, setup-needed, skip, hide/show, and error transitions with a mocked API/controller
- [ ] Verify:

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd apps/web
bun test src/domains/radio/audio-controller.test.ts src/domains/radio/radio-store.test.ts
```

## Task 6: Add The Composer Pill UI Behind The Feature Flag

- [ ] Create `apps/web/src/domains/radio/radio-composer-pill.tsx`.
- [ ] Use `Popover`, `Button`, and lucide icons such as `Radio`, `Music`, `Mic2`, `Play`, `Pause`, `SkipForward`, `ChevronUp`, `X`, and `Settings`.
- [ ] Collapsed pill content:
  - `On Air`
  - display cue label: `Song`, `DJ`, `Transition`, `Setup`, or `Off`
  - countdown when known
- [ ] Expanded popover content:
  - current track title and artist
  - next track title when known
  - progress bar
  - DJ transcript when present
  - play/pause, skip, hide, and settings CTA when setup is needed
- [ ] The settings CTA should navigate to `routes.settings.ai`.
- [ ] Keep the pill small enough for the composer row:
  - collapsed max width 180px
  - truncate long track text
  - no layout shift when countdown changes
- [ ] Edit `ChatComposerProps` in `apps/web/src/domains/chat/components/chat-composer/chat-composer.tsx` to add `radioSlot?: ReactNode`.
- [ ] Render `radioSlot` at the start of the bottom-left composer row before `thresholdPickerSlot`.
- [ ] Edit `apps/web/src/domains/chat/components/chat-route-content.tsx`:
  - read `const assistantRadio = useAssistantFeatureFlagStore.use.assistantRadio();`
  - pass `radioSlot` only when `assistantRadio && assistantId`
  - do not render it in app-editing side panels if it crowds the side composer; for the first slice, pass it only when `mainView !== "app-editing"`
- [ ] Add tests first:
  - `radio-composer-pill.test.tsx` renders collapsed, expanded, setup-needed, hide/show, and settings CTA states
  - `chat-composer.test.tsx` verifies `radioSlot` renders in the bottom-left row
- [ ] Verify:

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd apps/web
bun test src/domains/radio/radio-composer-pill.test.tsx src/domains/chat/components/chat-composer/chat-composer.test.tsx
```

## Task 7: Full Verification And Manual QA

- [ ] Run focused backend tests:

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd assistant
bun test src/radio/__tests__/catalog.test.ts src/radio/__tests__/dj-planner.test.ts src/radio/__tests__/radio-tts.test.ts src/runtime/routes/__tests__/radio-routes.test.ts src/__tests__/llm-callsite-catalog.test.ts
```

- [ ] Run backend typecheck:

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd assistant
bunx tsc --noEmit
```

- [ ] Run focused web tests:

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd apps/web
bun test src/domains/radio/audio-controller.test.ts src/domains/radio/radio-store.test.ts src/domains/radio/radio-composer-pill.test.tsx src/domains/chat/components/chat-composer/chat-composer.test.tsx
```

- [ ] Run web typecheck:

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd apps/web
bunx tsc --noEmit
```

- [ ] Start the local app and manually verify in the in-app browser:

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd apps/web
bun run dev
```

- [ ] Manual QA checklist:
  - flag off: no radio pill
  - flag on: tiny pill appears in main chat composer only
  - start: a demo song plays after user click
  - near song end or skip: UI shows `Cueing next break`
  - transition: music ducks, DJ audio plays, next song fades in
  - setup-needed: pill shows `Configure Text-to-Speech` and opens `/assistant/settings/ai`
  - mobile width: pill text truncates without overlapping composer buttons
  - hide: pill disappears for the current session without disabling the feature flag
