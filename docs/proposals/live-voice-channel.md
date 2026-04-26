# Live Voice Channel Integration Plan

## 1. Existing Infrastructure Map

This repository already has most of the production primitives needed for a local, push-to-talk live voice channel. The standalone proof of concept should be treated as a behavioral reference, not as code to copy: its FastAPI/WebSocket, prompt loader, direct provider clients, and global lock duplicate in-repo abstractions.

### `assistant/src/calls/`

This directory owns the existing phone-call and media-stream path. It is valuable because it already solved "voice turn" orchestration, token-to-TTS streaming, call event recording, transport abstraction, and Twilio media stream parsing. It is also telephony-shaped: many types assume phone numbers, Twilio call SIDs, DTMF/silence handling, and phone-specific safety rules.

Key files:

| Path | What it contains | Relevance to live voice channel |
| --- | --- | --- |
| `assistant/src/calls/call-controller.ts` | Turn controller for active voice calls. It manages caller utterances, assistant LLM turns, speech output, interrupts, and state transitions. | Reuse ideas and possibly internal helpers, but do not reuse wholesale for V1 because it is phone-call shaped. |
| `assistant/src/calls/voice-session-bridge.ts` | Bridge from voice input into the normal agent loop. It streams assistant text deltas and final messages back to a caller-supplied sink. | Strong reuse point for LLM inference. Needs a local-live-voice mode so it does not force phone-specific channel/prompt behavior. |
| `assistant/src/calls/call-transport.ts` | Transport interface for streaming text/audio commands to the voice endpoint. | Reusable abstraction shape, but local macOS playback needs a new transport implementation or a sibling live-voice stream protocol. |
| `assistant/src/calls/media-stream-server.ts` | Twilio Media Streams session orchestration. Wires media input, STT, output, and `CallController`. | Telephony-only. Useful as a reference for a long-lived audio WebSocket session. |
| `assistant/src/calls/media-stream-stt-session.ts` | STT adapter for Twilio media stream input. Handles media chunks, transcript callbacks, and stream lifecycle. | Mostly not reusable for local PTT because local audio can be PCM and has explicit PTT boundaries. |
| `assistant/src/calls/media-stream-output.ts` | Synthesizes assistant text and sends audio back through Twilio Media Streams. | Reuse provider/TTS strategy, not Twilio mu-law framing. |
| `assistant/src/calls/media-stream-parser.ts` and `assistant/src/calls/media-stream-protocol.ts` | Twilio media stream message parsing and protocol types. | Out of scope for V1 local mic. |
| `assistant/src/calls/call-state-machine.ts` | Allowed transitions for `CallStatus`. | Could inform local session state, but the existing states are phone-specific. |
| `assistant/src/calls/types.ts` | Core call session, event, status, transport, and pending-question types. | Too telephony-shaped to use as the persisted data model for local live voice. |
| `assistant/src/calls/call-store.ts` | Persistence helpers for call sessions and call events. | Good reference for event recording; not a good direct fit for local sessions because call records require phone fields. |
| `assistant/src/calls/active-call-lease.ts` | Workspace-backed active phone call leases. | Not the right single-session lock for local live voice; V1 can use an in-memory assistant process lock unless crash recovery is required. |
| `assistant/src/calls/tts-call-strategy.ts` | TTS provider selection strategy for calls. | Reusable policy reference for low-latency call audio. |
| `assistant/src/calls/audio-store.ts` | In-memory audio entries and streaming entries used for call playback URLs. | Possible reuse for short-lived generated audio, but archival needs durable local storage. |
| `assistant/src/calls/finalize-call.ts` and `assistant/src/calls/call-conversation-messages.ts` | Final phone-call cleanup and conversation summary messages. | Reuse the idea of conversation archival; V1 needs richer audio + transcript archival. |

Important existing signatures:

```ts
// assistant/src/calls/call-transport.ts
export interface CallTransport {
  sendTextToken(token: string, last: boolean): Promise<void>;
  sendPlayUrl(url: string): Promise<void>;
  endSession(reason?: string): Promise<void>;
  getConnectionState(): ConnectionState;
  readonly requiresWavAudio?: boolean;
}
```

```ts
// assistant/src/calls/voice-session-bridge.ts
export interface VoiceTurnOptions {
  conversationId: string;
  callSessionId?: string;
  content: string;
  assistantId?: string;
  trustContext?: AssistantTrustContext;
  isInbound: boolean;
  task?: string;
  skipDisclosure?: boolean;
  onTextDelta: (delta: string) => void | Promise<void>;
  onComplete?: () => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
  signal?: AbortSignal;
}

export function startVoiceTurn(opts: VoiceTurnOptions): Promise<VoiceTurnHandle>;
```

```ts
// assistant/src/calls/types.ts
export type CallStatus =
  | "initiated"
  | "ringing"
  | "in_progress"
  | "waiting_on_user"
  | "completed"
  | "failed"
  | "cancelled";
```

### `assistant/src/providers/speech-to-text/`

This directory owns provider-specific STT adapters and catalog metadata. It is the right production integration point for streaming STT. The live voice channel should use this layer instead of direct Deepgram/OpenAI/Gemini/xAI clients or PoC-specific environment variables.

Key files:

| Path | What it contains | Relevance to live voice channel |
| --- | --- | --- |
| `assistant/src/providers/speech-to-text/provider-catalog.ts` | Catalog entries for STT providers, supported boundaries, telephony routing, and streaming mode support. | Single source of truth for whether a provider can support low-latency live voice partials. |
| `assistant/src/providers/speech-to-text/resolve.ts` | Runtime resolver for batch and streaming transcribers based on `services.stt.provider` and credentials. | Primary API the live voice assistant-side session should call. |
| `assistant/src/providers/speech-to-text/deepgram-realtime.ts` | Deepgram realtime streaming adapter. | Candidate for sub-300ms partial transcripts. |
| `assistant/src/providers/speech-to-text/google-gemini-live-stream.ts` | Gemini live streaming adapter. | Candidate streaming provider. |
| `assistant/src/providers/speech-to-text/openai-whisper-stream.ts` | Incremental/batch-style Whisper stream adapter. | Useful fallback shape, but may not hit the sub-300ms partial target. |
| `assistant/src/providers/speech-to-text/xai-realtime.ts` | xAI realtime streaming adapter. | Candidate streaming provider. |
| `assistant/src/providers/speech-to-text/*.test.ts` | Provider resolver and adapter tests. | Patterns for fake providers and boundary tests. |

The shared STT types live in `assistant/src/stt/types.ts`:

```ts
export type SttProviderId =
  | "openai-whisper"
  | "deepgram"
  | "google-gemini"
  | "xai";

export type ConversationStreamingMode =
  | "realtime-ws"
  | "incremental-batch"
  | "none";

export type SttBoundaryId =
  | "daemon-batch"
  | "daemon-streaming";

export interface BatchTranscriber {
  readonly providerId: SttProviderId;
  readonly boundaryId: Extract<SttBoundaryId, "daemon-batch">;
  transcribe(request: SttTranscribeRequest): Promise<SttTranscribeResult>;
}

export interface StreamingTranscriber {
  readonly providerId: SttProviderId;
  readonly boundaryId: Extract<SttBoundaryId, "daemon-streaming">;
  start(onEvent: (event: SttStreamServerEvent) => void): Promise<void>;
  sendAudio(audio: ArrayBuffer | Uint8Array | Buffer, mimeType: string): void;
  stop(): void;
}
```

The existing runtime already exposes a streaming STT WebSocket:

| Path | What it contains |
| --- | --- |
| `assistant/src/stt/stt-stream-session.ts` | Session wrapper that creates a streaming transcriber, forwards partial/final/error/closed events, and manages lifecycle. |
| `assistant/src/runtime/http-server.ts` | Runtime WebSocket upgrade handling for `/v1/stt/stream`. |
| `gateway/src/http/routes/stt-stream-websocket.ts` | Gateway-authenticated client-facing proxy for `/v1/stt/stream`. |

For live voice, a single live-voice WebSocket should probably call the same resolver internally instead of asking the macOS client to coordinate two separate sockets.

### `assistant/src/tts/`

This directory owns provider-agnostic text-to-speech configuration, provider registration, and synthesis. It already includes Fish Audio support and streaming provider capability metadata.

Key files:

| Path | What it contains | Relevance to live voice channel |
| --- | --- | --- |
| `assistant/src/tts/types.ts` | Provider IDs, TTS use cases, synthesis request/result types, provider interface. | Primary type surface for live voice synthesis. |
| `assistant/src/tts/provider-catalog.ts` | TTS provider catalog, including Fish Audio capability metadata and credential key mapping. | Use this instead of PoC-specific Fish Audio env vars. |
| `assistant/src/tts/provider-registry.ts` | Provider registry and lookup. | Live voice can resolve the configured provider and require streaming support. |
| `assistant/src/tts/tts-config-resolver.ts` | Merges configured TTS defaults/provider settings. | Use existing voice config, including Fish Audio voice/model settings. |
| `assistant/src/tts/synthesize-text.ts` | High-level buffered synthesis helper. | Good for existing message playback, but live voice likely needs direct streaming access to `synthesizeStream`. |
| `assistant/src/tts/providers/fish-audio.ts` | Fish Audio adapter. | Primary V1 TTS provider for the s2-pro voice path if configured there. |
| `assistant/src/runtime/routes/tts-routes.ts` | HTTP endpoints for message TTS and generic text TTS. | Existing endpoint is buffered and `message-playback` oriented; not enough by itself for live low-latency chunk playback. |

Important existing signatures:

```ts
// assistant/src/tts/types.ts
export type TtsProviderId =
  | "elevenlabs"
  | "fish-audio"
  | "deepgram"
  | "xai"
  | (string & {});

export type TtsCallMode = "native-twilio" | "synthesized-play";
export type TtsUseCase = "phone-call" | "message-playback";

export interface TtsSynthesisRequest {
  text: string;
  useCase: TtsUseCase;
  voiceId?: string;
  signal?: AbortSignal;
  outputFormat?: "pcm";
}

export interface TtsProvider {
  readonly id: TtsProviderId;
  readonly capabilities: TtsProviderCapabilities;
  synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult>;
  synthesizeStream?(
    request: TtsSynthesisRequest,
    onChunk: (chunk: Buffer) => void | Promise<void>,
    onAlignment?: TtsAlignmentCallback,
  ): Promise<TtsSynthesisResult>;
}
```

```ts
// assistant/src/tts/synthesize-text.ts
export async function synthesizeText(
  options: SynthesizeTextOptions,
): Promise<TtsSynthesisResult>;
```

The live voice channel should preserve `services.tts` as the source of truth. If Fish Audio s2-pro requires model selection that is not currently expressible in `services.tts.providers["fish-audio"]`, that should be added to the provider config rather than hardcoding it in live voice.

### `assistant/src/security/`

Credential storage already exists and should be reused. The live voice channel should not read or write provider keys from the workspace, should not introduce new ad hoc environment variable handling, and should not read gateway-owned security directories directly.

Key files:

| Path | What it contains | Relevance to live voice channel |
| --- | --- | --- |
| `assistant/src/security/credential-backend.ts` | Generic credential backend interface. | Base contract used by secure key helpers. |
| `assistant/src/security/secure-keys.ts` | High-level secure key access, provider-key lookup, masked key lookup, env fallback via provider catalog. | STT/TTS/LLM provider keys should flow through here or existing provider resolvers. |
| `assistant/src/security/ces-credential-client.ts` | Credential Execution Service HTTP client. | Docker/container credential path. |
| `assistant/src/security/ces-rpc-credential-backend.ts` | CES-backed credential backend implementation. | Existing backend integration. |
| `assistant/src/security/encrypted-store.ts` | Local encrypted credential storage. | Local mode credential backend. |
| `assistant/src/security/credential-key.ts` | Credential key helpers. | Use existing key naming conventions. |
| `assistant/src/security/secret-patterns.ts` and `assistant/src/security/secret-scanner.ts` | Secret detection and masking rules. | If new integration-specific secrets are added later, update these patterns. |
| `assistant/src/security/secret-ingress.ts` | Controlled handling of incoming secrets. | Reference for any setup flow that accepts provider keys. |

Important existing signatures:

```ts
// assistant/src/security/credential-backend.ts
export interface CredentialBackend {
  isAvailable(): Promise<boolean>;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<CredentialEntry[]>;
  bulkSet?(items: CredentialBulkSetItem[]): Promise<void>;
}
```

```ts
// assistant/src/security/secure-keys.ts
export async function getSecureKeyAsync(
  keyName: string,
): Promise<string | undefined>;

export async function getProviderKeyAsync(
  provider: string,
): Promise<string | undefined>;
```

### `assistant/docs/`

The assistant docs already document architecture and provider onboarding. They should be updated only if implementation changes architecture, provider configuration, or runtime API behavior.

Key files:

| Path | What it contains | Relevance to live voice channel |
| --- | --- | --- |
| `assistant/ARCHITECTURE.md` | Current service architecture, STT boundaries, TTS provider abstraction, call routing, client/server roles. | Primary architecture reference. Any shipped live voice architecture should eventually be reflected here. |
| `assistant/docs/stt-provider-onboarding.md` | Required steps for adding STT providers and keeping provider catalogs/client fallbacks in sync. | Confirms live voice should use the existing STT catalog rather than a new provider path. |
| `assistant/docs/credential-execution-service.md` | Credential storage/access architecture. | Reference for provider-key handling and Docker mode. |
| `assistant/docs/error-handling.md` | Error handling conventions. | Use for live voice user-visible and structured error design. |
| `assistant/docs/plugins.md` and `assistant/docs/skills.md` | Plugin and skill docs. | Likely not directly involved in V1. |
| `assistant/docs/architecture/security.md` | Security architecture. | Reference if live voice adds new auth scopes or gateway routes. |
| `assistant/docs/architecture/integrations.md` | Integration architecture notes. | Reference if voice channel exposes new integration points. |
| `assistant/docs/architecture/memory.md` | Memory architecture notes. | Reference if archival changes memory/conversation persistence. |
| `assistant/docs/architecture/scheduling.md` | Scheduling architecture notes. | Not directly involved in V1. |

### macOS client voice infrastructure

The user-facing local mic and playback pieces live under `clients/macos/` and shared Swift networking code:

| Path | What it contains | Relevance to live voice channel |
| --- | --- | --- |
| `clients/macos/vellum-assistant/App/VoiceInputManager.swift` | Existing hotkey/hold-to-talk mic capture, partial transcript callbacks, streaming STT wiring, and recording state. | Strong reuse point for PTT capture behavior. |
| `clients/macos/vellum-assistant/Features/Voice/AudioEngineController.swift` | `AVAudioEngine` wrapper for mic capture, prewarm, route changes, and tap lifecycle. | Reuse for local PCM capture. |
| `clients/shared/Network/STTStreamingClient.swift` | Swift WebSocket client for `/v1/stt/stream` with ready/partial/final/error/closed events. | Reuse protocol/event patterns; live voice likely needs a sibling client because it carries TTS audio and turn events too. |
| `clients/shared/Network/STTClient.swift` | Batch STT client. | Fallback only; not sufficient for sub-300ms partials. |
| `clients/shared/Network/TTSClient.swift` | Buffered TTS HTTP client. | Existing playback helper path; not sufficient for streaming TTS chunks. |
| `clients/macos/vellum-assistant/Features/Voice/OpenAIVoiceService.swift` | Existing voice-mode service using service-first STT, Apple fallback, and gateway TTS playback. | Useful reference, but V1 live voice should not depend on OpenAI-specific naming or full-buffer playback. |
| `clients/macos/vellum-assistant/Features/Voice/VoiceModeManager.swift` | State machine for current chat voice mode. | Reference for local state and UI integration. Live voice likely needs a new manager because its session is phone-call-shaped and long-lived. |

## 2. Reuse vs New

| PoC component | Existing coverage | Recommendation |
| --- | --- | --- |
| WebSocket transport | Partially covered. Runtime/gateway already proxy `/v1/stt/stream`, and Twilio media streams already manage long-lived audio WebSockets. Neither route carries the complete live voice protocol of mic audio, transcript events, assistant text deltas, TTS chunks, interrupt, metrics, and archive completion. | Add a new gateway-authenticated live voice WebSocket route. Reuse runtime/gateway WebSocket patterns and STT stream session patterns. Do not port FastAPI. |
| Mic capture | Mostly covered on macOS. `VoiceInputManager` and `AudioEngineController` already implement hotkey/hold-to-talk capture and PCM conversion for streaming STT. | Reuse capture primitives, but add a dedicated live voice client/session manager so existing dictation/chat voice mode does not absorb phone-call-shaped state. |
| Streaming STT | Covered by provider catalog, resolver, streaming transcriber interface, runtime STT WebSocket, and macOS STT streaming client. | Reuse `resolveStreamingTranscriber()` internally from the live voice assistant session. Require a provider whose catalog entry supports `daemon-streaming` and `conversationStreamingMode: "realtime-ws"` for the latency target. |
| Inference adapter | Covered by the existing provider abstraction and `startVoiceTurn()` bridge into the agent loop. The PoC direct Anthropic/OpenAI/local-http adapters duplicate this. | Reuse the existing LLM provider stack through the voice turn bridge. Prefer an existing low-latency call-site profile initially; add a dedicated live voice call site only if tuning diverges. A local-http target should be modeled as a normal provider/profile, not a live voice special case. |
| Voice-mode prompt loader | Not covered as a direct PoC-style file loader, and should not be copied. Existing runtime already assembles user/workspace/system context for conversations. | Do not read identity or user files directly from live voice code. Use the normal conversation pipeline and, if needed, add a small local-live-voice control block analogous to phone-call control rules. |
| Streaming TTS | Partially covered. TTS provider registry and Fish Audio adapter support streaming capability, but public HTTP routes are buffered/message-playback oriented. | Reuse `services.tts`, provider registry, and Fish Audio adapter. Add a live voice streaming path that calls `TtsProvider.synthesizeStream()` and forwards chunks to macOS. |
| Audio playback | Partially covered. macOS currently has buffered playback via `TTSClient` and `AVAudioPlayer`; that is not ideal for low-latency streamed chunks. | Add streaming playback on macOS, probably under the live voice feature, using the default output device. Reuse existing audio session/route handling where possible. |
| Latency metrics | Partially covered by logging/tracing patterns, but no live voice p50/p95 metric object exists. The PoC has a useful turn-level metric model. | Add small live voice metrics types for STT final latency, first LLM delta, first TTS audio, total turn time, and rolling summaries. Keep them local to the live voice module first. |
| Conversation archival | Partially covered. Conversations and phone-call summary messages exist, but phone finalization archives summaries, not full local audio plus transcript. | Add live voice archival that writes normal conversation messages plus durable local audio artifacts. Reuse message metadata for `userMessageChannel: "vellum"` and `userMessageInterface: "macos"` unless a new channel is proven necessary. |
| Single-session lock | Partially covered. Phone calls have active call leases and active call lookup, but these are phone-call data model concepts. | Add an in-memory `LiveVoiceSessionManager` single active session lock for V1. Consider a workspace-backed lease only if crash recovery or cross-process ownership becomes required. |

## 3. Proposed Architecture

### Shape

Add a first-class live voice module rather than extending the telephony call data model:

```text
clients/macos
  LiveVoiceChannelManager
    - owns PTT hotkey state
    - streams local PCM audio
    - plays streamed TTS chunks
    - displays state, transcripts, and errors
          |
          | gateway-authenticated WebSocket
          v
gateway/src/http/routes/live-voice-websocket.ts
    - actor auth
    - route policy/scope enforcement
    - proxy to assistant runtime with service token
          |
          v
assistant/src/runtime/http-server.ts
    - WebSocket upgrade for /v1/live-voice
          |
          v
assistant/src/live-voice/
    LiveVoiceSessionManager
      - single active session lock
      - session lifecycle
      - frame protocol
      - latency metrics
      - archival coordination
    LiveVoiceSession
      - StreamingTranscriber from STT resolver
      - voice turn bridge into agent loop
      - streaming TTS provider
      - conversation messages and audio artifacts
```

This keeps the Twilio/phone call path intact while still reusing its lower-level lessons:

| Existing phone path | Live voice V1 difference |
| --- | --- |
| Twilio inbound/outbound phone sessions. | Local macOS session initiated by an authenticated app user. |
| Twilio Media Streams protocol, mu-law frames, stream SID, call SID. | PCM from local mic; no Twilio IDs or telephony codec requirements. |
| Always-connected phone audio with speech start/end heuristics. | Push-to-talk with explicit press/release boundaries. |
| Phone-specific call state, DTMF, ringing, pending questions, disclosures. | Local session states: idle, listening, transcribing, thinking, speaking, ending. |
| Phone channel metadata. | Normal Vellum/macOS conversation metadata. |
| Audio sent back through Twilio transport. | Audio chunks played through default macOS output. |

### Assistant-side module

Recommended new directory:

```text
assistant/src/live-voice/
  protocol.ts
  live-voice-session-manager.ts
  live-voice-session.ts
  live-voice-stt.ts
  live-voice-tts.ts
  live-voice-archive.ts
  live-voice-metrics.ts
  __tests__/
```

Candidate public types:

```ts
export interface LiveVoiceSessionManager {
  startSession(options: LiveVoiceStartOptions): Promise<LiveVoiceSessionHandle>;
  getActiveSession(): LiveVoiceSessionSnapshot | null;
  endActiveSession(reason: LiveVoiceEndReason): Promise<void>;
}

export interface LiveVoiceStartOptions {
  conversationId?: string;
  assistantId?: string;
  actorId: string;
  audio: {
    mimeType: "audio/pcm";
    sampleRate: 16000 | 24000 | 48000;
    channels: 1;
  };
}

export interface LiveVoiceSessionHandle {
  readonly sessionId: string;
  readonly conversationId: string;
  receiveAudio(chunk: Buffer): void;
  releasePushToTalk(): Promise<void>;
  interrupt(): Promise<void>;
  end(reason: LiveVoiceEndReason): Promise<void>;
}
```

Candidate WebSocket protocol:

```ts
export type LiveVoiceClientFrame =
  | {
      type: "start";
      conversationId?: string;
      audio: {
        mimeType: "audio/pcm";
        sampleRate: number;
        channels: 1;
      };
    }
  | { type: "audio"; dataBase64: string }
  | { type: "ptt_release" }
  | { type: "interrupt" }
  | { type: "end" };

export type LiveVoiceServerFrame =
  | { type: "ready"; sessionId: string; conversationId: string }
  | { type: "busy"; activeSessionId: string }
  | { type: "stt_partial"; text: string; seq: number }
  | { type: "stt_final"; text: string; seq: number }
  | { type: "thinking"; turnId: string }
  | { type: "assistant_text_delta"; text: string; seq: number }
  | {
      type: "tts_audio";
      mimeType: "audio/pcm";
      sampleRate: number;
      dataBase64: string;
      seq: number;
    }
  | { type: "tts_done"; turnId: string }
  | {
      type: "metrics";
      turnId: string;
      sttMs?: number;
      llmFirstDeltaMs?: number;
      ttsFirstAudioMs?: number;
      totalMs?: number;
    }
  | { type: "archived"; conversationId: string; sessionId: string }
  | { type: "error"; code: string; message: string };
```

Binary frames can replace base64 audio after the first implementation pass, but the protocol should remain explicit about which direction and state each audio frame belongs to. The PoC's "JSON control frames plus binary PCM" shape is sound; the production version should add authentication, conversation IDs, provider-agnostic errors, and archive events.

### STT flow

The live voice session should use the assistant-side streaming resolver:

```ts
resolveStreamingTranscriber({
  sampleRate: options.audio.sampleRate,
});
```

The session forwards `SttStreamServerEvent` partial/final events to the macOS client and buffers enough transcript state to decide what text becomes the user turn on `ptt_release`. Providers that only support incremental batch can remain available for existing chat voice mode, but they should be treated as not meeting the live voice latency target unless measured otherwise.

### LLM flow

The right production path is the normal conversation/agent loop, not the PoC's direct inference adapters.

Recommended V1 approach:

1. On final transcript, archive the local user's utterance as a normal conversation user message.
2. Call a generalized voice turn bridge that reuses `startVoiceTurn()` internals.
3. Stream assistant text deltas back to the live voice session.
4. Feed deltas into streaming TTS when sentence or provider chunking boundaries are available.
5. Archive the assistant transcript as a normal conversation assistant message.

The current `startVoiceTurn()` is close, but its type and implementation assume phone calls in a few places:

| Current behavior | Live voice need |
| --- | --- |
| `callSessionId?: string` and phone-call event sink naming. | `voiceSessionId` or a generic voice turn ID. |
| Phone-call control prompt. | Local-live-voice control prompt, or no extra prompt if existing context is sufficient. |
| Phone channel metadata. | `vellum` channel with `macos` interface metadata, unless a new channel is justified. |
| Voice confirmation/guardian policy tuned for phone. | Confirm local host-computer and identity-boundary behavior with security rules before reuse. |

The bridge should be generalized with the smallest surface needed, not forked into a separate inference adapter.

### TTS flow

Live voice should resolve TTS through existing config:

```ts
const config = resolveTtsConfig(...);
const provider = getTtsProvider(config.provider);
await provider.synthesizeStream?.(
  {
    text,
    useCase: "phone-call",
    outputFormat: "pcm",
    signal,
  },
  onChunk,
);
```

The exact code will depend on current registry APIs, but the rule is: use provider config and credential catalogs, not live voice env vars. If `"phone-call"` is too semantically tied to telephony, add a new `TtsUseCase` such as `"live-voice"` and update provider support deliberately. For V1, reusing `"phone-call"` is acceptable if it maps to the same low-latency synthesized-play behavior.

### macOS responsibilities

The macOS client should own:

- PTT hotkey lifecycle and visual state.
- Mic permission prompts and local capture via existing audio engine utilities.
- PCM frame pacing and WebSocket reconnect/error UX.
- Default output playback for streamed TTS chunks.
- User-visible transcript/partial transcript display.
- Explicit interrupt/end actions.

The assistant should own:

- Provider resolution and credentials.
- Streaming STT.
- Conversation context and inference.
- Streaming TTS provider calls.
- Conversation transcript and audio archival.
- Single active live voice session enforcement.
- Latency metrics.

The split keeps provider keys, user context, and policy decisions inside the assistant instead of moving them into the macOS client.

### Conversation archival

V1 must archive both transcript and audio locally. Existing phone-call finalization only writes a completion-style message, so live voice needs explicit archival work.

Recommended shape:

- Store user and assistant transcript turns as normal conversation messages.
- Mark local voice metadata with existing channel/interface fields:
  - `userMessageChannel: "vellum"`
  - `assistantMessageChannel: "vellum"`
  - `userMessageInterface: "macos"`
  - `assistantMessageInterface: "macos"`
- Store captured user audio and synthesized assistant audio as durable local artifacts linked from message metadata or attachments.
- Prefer reusing an existing media/attachment store if it already supports durable conversation-local audio. If it does not, add a small live voice audio artifact store under the workspace with an idempotent migration if any persisted schema/path changes are introduced.

Do not add a new `ChannelId` for V1 unless a real policy or reporting requirement needs it. Adding a channel touches capabilities, routing, policy, and analytics surfaces; interface metadata is enough to distinguish local voice from text chat.

## 4. Milestones

### Milestone 1: live voice protocol and session shell

Add assistant/gateway WebSocket routing, protocol types, a `LiveVoiceSessionManager`, single active session lock, and macOS client connection plumbing. Stub STT/LLM/TTS behavior is acceptable in this PR if the route lifecycle is real.

Acceptance criteria:

- A macOS or test client can connect, receive `ready`, send `end`, and observe clean shutdown.
- A second concurrent session receives a deterministic `busy` response.
- Gateway auth and runtime service-token patterns match existing WebSocket routes.
- Tests cover start/end, busy lock, malformed frames, and disconnect cleanup.

### Milestone 2: streaming STT integration

Wire live voice audio frames to `resolveStreamingTranscriber()` and forward partial/final transcript events to the client. Keep PTT release as the turn boundary.

Acceptance criteria:

- Tests with a fake `StreamingTranscriber` prove partial and final events are forwarded in order.
- Providers without assistant-side streaming support fail with a clear configuration error.
- The macOS client can display partial transcripts during a held PTT session.
- Batch fallback is explicitly disabled for the latency-critical live voice path unless product accepts degraded mode.

### Milestone 3: conversation and LLM turn bridge

Generalize or wrap the existing voice turn bridge so live voice sends final transcripts through the normal conversation agent loop and streams assistant text deltas back over the live voice WebSocket.

Acceptance criteria:

- A final transcript creates a normal conversation user turn.
- Assistant text deltas stream back before the full response is complete.
- The implementation uses the provider abstraction and configured call site/profile, not direct provider clients.
- Tests prove conversation IDs, assistant IDs, cancellation, and error propagation behave correctly.

### Milestone 4: Fish Audio streaming TTS and local playback

Use the configured TTS provider, with Fish Audio as the expected V1 provider, to stream audio chunks to macOS and play them through the default output device.

Acceptance criteria:

- The assistant emits `tts_audio` chunks before synthesis is fully complete when the provider supports streaming.
- The configured Fish Audio voice/model is honored through `services.tts`.
- macOS playback starts from streamed chunks, not only from a fully buffered file.
- Interrupt/end stops in-flight TTS and local playback.

### Milestone 5: archival, metrics, and latency harness

Persist transcript and local audio artifacts, add turn-level latency metrics, and provide a small manual or automated harness for p50/p95 measurement.

Acceptance criteria:

- A completed session appears in local conversation history with user transcript, assistant transcript, and linked audio artifacts.
- Metrics include STT final latency, first LLM delta, first TTS audio, and total turn time.
- A debug view or log line reports rolling p50/p95 for recent live voice turns.
- A local stub-mode test path can run without real provider credentials.

## 5. Open Questions

### Should live voice share `CallController` or use a new session controller?

Recommendation: use a new live voice session controller and share lower-level pieces such as the voice turn bridge, TTS provider logic, and state-machine patterns.

Trade-offs:

- Sharing `CallController` reduces duplication, but pulls in phone states, Twilio transport assumptions, DTMF/silence behavior, and phone-call metadata.
- A new controller adds some orchestration code, but keeps V1 local PTT behavior clean and prevents telephony concepts from becoming required for a desktop session.

### Should the route be `/v1/live-voice` or part of `/v1/calls`?

Recommendation: use a new `/v1/live-voice` WebSocket route, proxied by the gateway.

Trade-offs:

- `/v1/calls` emphasizes reuse, but suggests telephony semantics and may inherit call permissions accidentally.
- `/v1/live-voice` makes the product boundary clear and lets route policy require the right local authenticated actor scope.

### Should live voice use `"phone-call"` or a new `"live-voice"` TTS use case?

Recommendation: reuse `"phone-call"` for the first implementation if it already selects low-latency synthesized-play behavior, then split to `"live-voice"` only when provider tuning differs.

Trade-offs:

- Reusing `"phone-call"` minimizes schema churn.
- A new use case is semantically cleaner and allows local-voice-specific model/format defaults, but requires config/schema/provider test updates.

### Should inference use the existing `callAgent` call site or a new `liveVoiceAgent` call site?

Recommendation: start with the existing low-latency voice/call call site if its behavior is appropriate. Add `liveVoiceAgent` only when model, max token, thinking, or latency settings need to diverge from phone calls.

Trade-offs:

- Reusing `callAgent` avoids another config surface.
- A dedicated call site gives cleaner tuning and metrics but requires schema/default/config documentation updates.

### Where should the macOS client feature live?

Recommendation: add a dedicated live voice manager under the macOS voice feature area, reusing `AudioEngineController` and hotkey patterns from `VoiceInputManager`.

Trade-offs:

- Extending `VoiceModeManager` keeps all voice UI together, but it already models turn-based chat voice mode.
- A dedicated `LiveVoiceChannelManager` can model long-lived session states, streaming playback, interrupt, and metrics without overloading dictation/chat voice code.

### Should STT use one live voice WebSocket or compose the existing STT WebSocket plus another control socket?

Recommendation: one live voice WebSocket, with the assistant session internally using `StreamingTranscriber`.

Trade-offs:

- Reusing the public STT WebSocket directly avoids new STT plumbing, but forces the macOS client to correlate audio, transcript, LLM, TTS, metrics, and archival across sockets.
- One live voice socket gives cleaner ordering and latency measurement while still reusing the same provider resolver and adapter layer.

### Where should audio archival live?

Recommendation: first evaluate existing durable media/attachment storage. If it cannot represent conversation-linked audio artifacts cleanly, add a small live voice audio store and document the workspace path.

Trade-offs:

- Reusing media/attachments avoids another storage concept.
- A dedicated store can preserve exact local voice session structure, but any persisted path/schema needs migration discipline and architecture docs.

### Should local-http inference be first-class in V1?

Recommendation: only if it is represented as a normal provider/profile in the existing LLM abstraction. Do not add a live-voice-only local-http adapter.

Trade-offs:

- Local HTTP may be the fastest target for local development and latency testing.
- A special adapter bypasses provider configuration, credentials, tracing, and call-site policy.

### Should OpenAI Realtime API be supported directly?

Recommendation: defer direct OpenAI Realtime integration for V1 unless it is added through the provider abstraction and there is a measured latency reason to do so.

Trade-offs:

- A direct realtime API can collapse STT, inference, and TTS into one session.
- It bypasses existing provider-pluggable architecture and conflicts with the requested Fish Audio voice path unless carefully abstracted.

### How should V1 handle barge-in?

Recommendation: explicit interrupt only. Do not infer smart barge-in from VAD in V1.

Trade-offs:

- Explicit interrupt is predictable and small.
- Smart barge-in improves conversational feel, but requires reliable local VAD, TTS cancellation semantics, and interruption policy.

## 6. Out of Scope (V1)

V1 should not include:

- Always-on VAD or wake-word listening.
- Twilio/PSTN phone path for the local live voice channel.
- Voice clone work needed for a future phone path.
- Avatar rendering, lip sync, or visual embodiment changes.
- Smart barge-in based on detected speech overlap.
- Multi-device live voice sessions.
- More than one active live voice session at a time.
- New STT or TTS providers beyond what is required to use the existing provider abstraction.
- A PoC-style prompt loader that directly reads private workspace identity files.
- New persistent approval modes, trust-rule UI, or broad host-computer permission toggles.
- Managed/cloud deployment latency guarantees unless explicitly scoped in a later milestone.
