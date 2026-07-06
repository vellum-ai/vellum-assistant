# Voice Mode: Full-Duplex In-App Voice

> **Status:** Proposal (kickoff draft, 2026-07-06). Supersedes [`live-voice-channel.md`](./live-voice-channel.md), whose V1 plan shipped and whose reuse assessments predate the phone-pipeline migration (PR #37047). Durable architecture reference: `assistant/ARCHITECTURE.md`.
>
> **Implementation update (2026-07-06):** the duplex engine described in §3 — server duplex integration plus the multi-turn protocol and web client (workstreams 1–2 of §4) — has landed on the `voice-mode-engine` feature branch via the voice-mode-engine plan. Product UX, session policy revisits, cloud rollout, and synthesis consolidation (workstreams 3–6) remain open.
>
> **Goal:** bring the phone-call conversation experience into the app itself — a full-duplex, multi-turn, barge-in-capable voice conversation with the assistant, replacing the shipped V1's push-to-talk single-utterance model.

## 1. Where we are

Two voice front-ends exist on `main` today, both driving the same brain — `startVoiceTurn()` in `assistant/src/calls/voice-session-bridge.ts`, which runs a voice turn through the normal agent loop (same LLM, tools, memory, skills, approvals, persistence). Voice mode is a transport and turn-taking project, not a new inference path.

| | Phone calls (`assistant/src/calls/`) | Live voice V1 (`assistant/src/live-voice/`) |
| --- | --- | --- |
| Transport | Twilio Media Streams WS at `/v1/calls/media-stream` (μ-law 8 kHz) | Client WS at `/v1/live-voice` (PCM16 16 kHz in, streamed TTS out) |
| Turn-taking | Full-duplex: energy-VAD barge-in, silence/turn detection, silence nudge, END_CALL listen window, duration limits (`CallController`) | Half-duplex push-to-talk; manual `interrupt` frame; single utterance per socket |
| STT | Streaming with catalog gating + batch fallback + startup buffering (`MediaStreamSttSession`) | Bare `resolveStreamingTranscriber()` call, no fallback/resilience |
| Sessions | `call_sessions`/`call_events`, multi-turn until hangup | In-memory, single active session per daemon (`live-voice-session-manager.ts`) |
| Clients | PSTN caller | Web client (`clients/web/src/domains/chat/voice/live-voice/`), composer-wired, dark behind the `voice-mode` flag. macOS is an Electron shell around the same web code; there is no other client. |

### What PR #37047 changed (why the V1 plan is superseded)

Until 2026-07-02, phone calls ran on Twilio ConversationRelay — **Twilio owned STT and TTS**, so the phone stack's speech handling was structurally unreusable for in-app voice, and the V1 plan correctly said so. #37047 (JARVIS-1111) removed ConversationRelay entirely and moved the whole speech pipeline into the daemon:

- **`CallController` is transport-decoupled.** It takes a `CallTransport` (`assistant/src/calls/call-transport.ts`), an interface written explicitly so "alternative transports can be introduced without modifying controller logic." Constructor surface: `(callSessionId, transport, task, opts)`.
- **`MediaStreamSttSession` is transport-neutral** (callback hooks: `onSpeechStart`, `onTranscriptFinal`, `onDtmf`, `onStop`) and carries production hardening: catalog-gated streaming vs per-turn batch (Deepgram realtime with utterance-boundary finals; whisper/gemini/xai batch), batch fallback when the streaming socket dies mid-session, bounded startup buffering (~10 s of frames), and barge-in driven by a local energy VAD — never by transcriber partials.
- **`MediaTurnDetector`** (`media-turn-detector.ts`) is integration-neutral by design: the caller supplies per-chunk speech classification; it emits turn-start/turn-end callbacks on silence-threshold (800 ms default) and max-duration boundaries.
- **Credential preflight** (`telephony-credential-preflight.ts`): calls fail before dialing when STT/TTS keys are missing, instead of erroring mid-conversation.
- The controller inherits the JARVIS-1232 barge-in race fixes and exactly-once call finalization.

Net: the phone stack went from "Twilio does the speech" to "the daemon does the speech over an abstract transport." That collapses most of the server-side work for voice mode into integration.

## 2. Revised reuse map

Replaces §1–2 of the superseded doc.

| Component | Verdict | Notes |
| --- | --- | --- |
| `voice-session-bridge.ts` / `startVoiceTurn()` | **Reuse as-is** | Already shared by both stacks; `approvalMode: "local-live-voice"` path exists. |
| `CallController` (`call-controller.ts`) | **Adopt via a new `CallTransport` impl** | Buys the idle→processing→speaking state machine, barge-in, silence nudge, END_CALL listen window + re-engagement cap, duration timers, guardian consultation, control-marker protocol. See §3 for the coupling caveats. |
| `CallTransport` (`call-transport.ts`) | **Implement for live voice** | `sendTextToken`, `sendPlayUrl`, `endSession`; optional `setAudioStartCallback`, `discardPendingText`. Set `requiresWavAudio: false` — no μ-law transcoder, so compressed TTS formats are fine. |
| `MediaTurnDetector` (`media-turn-detector.ts`) | **Reuse directly** | Server-side open-mic turn detection. Replaces the web client's fragile client-side auto-release heuristic (120 ms speech + 1 s silence). |
| `MediaStreamSttSession` (`media-stream-stt-session.ts`) | **Lift the patterns; port the VAD** | The resilience patterns (catalog gating, batch fallback, startup buffering, VAD-driven barge-in) belong in the live-voice ingest path. The energy heuristic itself is μ-law-specific (`media-stream-stt-session.ts:710`); write the trivial PCM16 equivalent. Ingest framing (Twilio frame parsing, μ-law decode) stays telephony-only — note it already normalizes to 16 kHz PCM16, the exact format the live-voice client sends, so everything downstream of decode is format-compatible. |
| STT resolver + provider catalog | **Reuse (already shared)** | `resolveStreamingTranscriber()` hardening from #37047 benefits live voice for free. Streaming requires `conversationStreamingMode: "realtime-ws"` (deepgram, google-gemini, xai). |
| TTS stack (`assistant/src/tts/`) | **Reuse (already shared)** | Streaming requires `synthesizeStream()` — Fish Audio only today; single point of failure to track. |
| `telephony-credential-preflight.ts` | **Adopt the pattern** | Preflight STT/TTS keys at `start`-frame time; reject the session with a clear error instead of dying on the first turn. |
| `CallSetupFlow` + `GuardianWaitController` | Available, likely unneeded | Now transport-agnostic, but in-app users are already authenticated; no admission/verification flow needed. |
| `live-voice/` V1 module | **Keep transport + protocol; replace orchestration** | `protocol.ts`, session manager shell, archive, metrics survive. `LiveVoiceSession`'s STT→turn→TTS orchestration is what `CallController` replaces. |
| Web client (`clients/web/.../live-voice/`) | **Keep; extend** | Capture, playback, store, connection/auth all stand. Needs multi-turn protocol support and continuous-mic UX (§4). |
| ConversationRelay anything | **Gone** | `relay-server.ts`, `/v1/calls/relay`, gateway relay proxy, `telephony-stt-routing.ts` were deleted. Ignore references in older docs/plans. |
| Native-twilio TTS subsystem (`resolveVoiceQualityProfile`, voice-spec registry, `callMode`) | **Do not touch** | Flagged dead / pending removal in #37047's deferred follow-ups. |

## 3. Proposed architecture

Adopt `CallController` over the live-voice WebSocket, rather than growing duplex logic inside `LiveVoiceSession`:

```text
clients/web  live-voice module (capture: 16 kHz PCM16 worklet; playback: gapless Web Audio)
      | WS /v1/live-voice  (cloud: browser → velay → gateway tunnel/loopback → runtime;
      |                     self-hosted: browser → gateway → runtime)
      v
assistant/src/live-voice/
  LiveVoiceSessionManager        (session lifecycle, single-session policy, metrics, archive)
  LiveVoiceIngest                (PCM frames → energy VAD → MediaTurnDetector
                                  → streaming STT w/ batch fallback + startup buffer)
  LiveVoiceTransport : CallTransport
                                 (assistant text tokens → streaming TTS → tts_audio frames;
                                  requiresWavAudio=false; discardPendingText on barge-in)
      v
assistant/src/calls/CallController   (state machine, barge-in, timers, markers, guardian consult)
      v
voice-session-bridge.startVoiceTurn() → conversation.runAgentLoop()
```

The ingest side mirrors what `media-stream-server.ts` does for Twilio: VAD classifies each PCM chunk, `MediaTurnDetector` segments turns, speech-start during `speaking` state triggers `CallController.handleBargeIn()` (abort in-flight turn, flush queued TTS), transcript finals drive turns.

### Controller coupling to resolve

_Resolved as shipped: `VoiceSessionSource` abstracts session reads and `VoiceControllerProfile` (with `createInAppVoiceControllerProfile()`) carries the per-flavor behavior below (`assistant/src/calls/voice-session-source.ts`)._

**Decided (2026-07-06): no session-record concept for in-app voice.** Live-voice sessions are just conversations — user and assistant turns persist as normal messages in the conversation (which is what V1 already does). `CallController`'s session lookup gets abstracted behind a session-source interface; `call_sessions`/`call_events` stay phone-only. Known couplings to break:

- `getCallSession(callSessionId)` in the constructor for `conversationId`/`skipDisclosure` (`call-controller.ts:184`) — replace with an injected session source; live voice supplies `conversationId` directly and has no disclosure concept.
- Disclosure announcement, inbound-verification behavior, and the phone-shaped control-marker prompt (`buildVoiceCallControlPrompt`) need an in-app variant: no disclosure, no callee verification, guardian consultation becomes a normal in-app approval, `[END_CALL]` maps to session end.
- Phone approval policy (auto-deny side-effect tools) must not apply; live voice already has the interactive `local-live-voice` approval mode.
- Call-event recording (`recordCallEvent`) and pointer/completion messages are phone-only; live voice keeps its existing archive path (`live-voice-archive.ts`).

### Protocol changes (`live-voice/protocol.ts`)

V1's frames mostly survive. Deltas:

- **Multi-turn:** drop single-utterance-per-socket. `ptt_release` becomes optional (retained for a PTT mode); in open-mic mode the server segments turns itself and emits a new `turn_boundary`/`listening` signal so the client can render state.
- **Barge-in:** server-detected; `interrupt` frame retained as a manual override. Server emits an explicit `interrupted` frame so playback flushes deterministically (the client already supports generation-token flush in `tts-playback.ts`).
- **Mode negotiation in `start`:** `mode: "open-mic" | "ptt"`.

### Configuration

Add a `liveVoice.*` config namespace mirroring `calls.voice.*`: mode default (open-mic vs PTT), VAD sensitivity / silence threshold, max session duration. Continue sourcing providers from `services.stt` / `services.tts` — no live-voice-specific provider config.

## 4. Gap list → workstreams

1. **Server: duplex integration** — `LiveVoiceTransport`, PCM16 energy VAD, `MediaTurnDetector` wiring, controller session-source abstraction, in-app control prompt, credential preflight at `start`. Mostly integration of #37047 components. _Shipped (voice-mode-engine plan; the transport landed as `LiveVoiceCallTransport`, the session-source abstraction as `VoiceSessionSource` + `VoiceControllerProfile`)._
2. **Protocol + client: multi-turn sessions** — protocol deltas above; web client state machine (`use-live-voice.ts`) moves from single-utterance to continuous session with server-driven turn boundaries; seamless barge-in without socket teardown. _Shipped (voice-mode-engine plan)._
3. **Product UX** — today the UI is one composer button + amplitude. Define the in-conversation voice surface (overlay/screen, transcript display, interrupt affordance, session end).
4. **Session policy** — revisit the single-active-session lock (`live-voice-session-manager.ts`) for multi-tab/multi-device; V1's `busy` frame is the fallback.
5. **Cloud rollout** — verify the Django `POST /v1/auth/live-voice-token/` mint endpoint is live platform-side (the client assumes it in `connection.ts`); measure the 3-hop cloud path (browser→velay→gateway→runtime) with the existing per-turn `metrics` frames before considering transport changes; `voice-mode` flag targeting (LaunchDarkly, platform repo terraform + dashboard).
6. **Synthesis consolidation** (optional, pre-blessed) — #37047 explicitly deferred consolidating the three copied provider-synthesis paths (phone `call-speech-output.ts`/`tts-call-strategy.ts`, `live-voice-tts.ts`, message-TTS). Natural to absorb if phone and in-app unify on one controller.

## 5. Decisions superseding the old doc's open questions

| Old question | Old answer (V1) | Voice-mode answer |
| --- | --- | --- |
| Share `CallController`? | No — new controller | **Yes, via `CallTransport`** — the interface now exists for this; rebuilding duplex turn-taking would duplicate a production-hardened engine. |
| Barge-in strategy | Explicit interrupt only | **Server-side VAD barge-in** (phone parity); manual interrupt retained. |
| `/v1/live-voice` vs `/v1/calls` | `/v1/live-voice` | Unchanged — keep `/v1/live-voice`. |
| One socket vs STT socket + control socket | One socket | Unchanged. |
| TTS use case `"phone-call"` vs `"live-voice"` | Reuse `"phone-call"` | Revisit during synthesis consolidation; not a blocker. |
| macOS client location | New Swift `LiveVoiceChannelManager` | **Obsolete** — macOS is Electron around the web client; the web module is the only client. |
| OpenAI Realtime | Defer | Still deferred; re-evaluate only if measured cloud latency (via `metrics` frames) misses target. |

## 6. Decisions and remaining open questions

Decided 2026-07-06:

- **Session records:** none — conversations only (§3).
- **Mode default: PTT.** Open-mic ships as a mode behind the same engine (the server-side VAD/turn-detection path must still be built so barge-in works during assistant playback), but PTT is the default; open-mic may land Electron-first later.
- **Echo handling: deferred.** With PTT default the mic isn't streaming during playback, so it's moot for launch; revisit when open-mic becomes a default anywhere.
- **Multi-tab: keep V1 behavior** — single active session per daemon; a second concurrent session gets the `busy` frame.

Still open:

- **Latency budget:** what p50/p95 turn latency is acceptable on the cloud path before transport work (e.g. WebRTC — currently zero in-repo infrastructure) enters scope?

## 7. Out of scope

- Wake words / always-on ambient listening (open-mic applies only within an explicit voice session).
- Changes to the PSTN phone path beyond shared-code refactors.
- WebRTC or any new transport infrastructure (measure first; see §6).
- New STT/TTS providers, except unblocking a second streaming-TTS provider if Fish Audio's `synthesizeStream()` exclusivity becomes a launch risk.
- Voice cloning, avatars, visual embodiment.
