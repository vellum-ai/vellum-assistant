/**
 * MeetSessionManager — orchestrates per-meeting bot container lifecycle.
 *
 * Responsibilities:
 *   - Generate a unique `BOT_API_TOKEN` per meeting so the ingress route
 *     (PR 9) can authenticate inbound bot callbacks.
 *   - Stage per-meeting artifact directories (`sockets/`, `out/`) on the
 *     workspace volume.
 *   - Resolve a placeholder TTS key reserved for Phase 3 via the
 *     secure-keys abstraction. STT credentials are resolved inside the
 *     audio-ingest via the configured `services.stt.provider`.
 *   - Drive `DockerRunner` to create + start the Meet-bot container with the
 *     right env/workspaceMounts/port mappings.
 *   - Register the per-meeting handler with `MeetSessionEventRouter` via
 *     the shared `meetEventDispatcher` so multiple subscribers (this
 *     manager, the conversation bridge, the storage writer, the consent
 *     monitor) can observe the same live event stream.
 *   - Publish `meet.joining` / `meet.joined` / `meet.left` / `meet.error`
 *     lifecycle events on the assistant event hub so SSE-connected clients
 *     can render live meeting state.
 *   - Enforce `services.meet.maxMeetingMinutes` via a hard-cap timeout that
 *     invokes `leave(id, "timeout")`.
 *   - On `leave`, best-effort hit the bot's `/leave` first; fall back to
 *     `DockerRunner.stop` + `remove` so stuck bots don't leak containers.
 *   - Start a {@link MeetAudioIngest} before the container spawns so the
 *     bot has a socket to connect to the moment it boots, and tear the
 *     ingest down after the container is removed on leave. The ingest
 *     resolves the STT provider from `services.stt.provider` on its own
 *     — this class does not pass any API keys through.
 *   - Spin up a {@link MeetConsentMonitor} per meeting so objection
 *     phrases on transcript/chat trigger an auto-leave when
 *     `services.meet.autoLeaveOnObjection` is enabled.
 *   - Wire a {@link MeetConversationBridge} so transcripts, chat, and
 *     participant events become conversation messages in the target
 *     conversation.
 *   - Wire a {@link MeetStorageWriter} and connect it to the audio
 *     ingest's PCM fan-out so `audio.opus`, `transcript.jsonl`,
 *     `segments.jsonl`, `participants.json`, and `meta.json` are
 *     materialized under `<workspace>/meets/<meetingId>/`.
 *
 * Caller contracts worth noting:
 *   - `{assistantName}` substitution in `CONSENT_MESSAGE` is performed by
 *     the `meet_join` tool (PR 23) before invoking `join()`. Direct callers
 *     that skip the tool are still protected: `join()` performs the same
 *     substitution against the resolved assistant display name before
 *     forwarding to the bot container.
 *   - `JOIN_NAME` is resolved in-manager as
 *     `services.meet.joinName ?? getAssistantName() ?? MEET_JOIN_NAME_FALLBACK`
 *     so the bot always receives a non-empty value and never silently
 *     downgrades to screenshot-only mode.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  DaemonRuntimeMode,
  Logger,
  SkillHost,
} from "@vellumai/skill-host-contracts";

// Side-effect imports: every sub-module file calls `registerSubModule` at
// module-load time so its factory is reachable via `getSubModule` below.
// The session manager pulls those factories dynamically (rather than taking
// a static dependency on each class), so we need explicit side-effect
// imports here to guarantee the registrations fire before the constructor
// runs. Adding a sub-module in the future? Add its import here.
import "./audio-ingest.js";
import "./barge-in-watcher.js";
import "./chat-opportunity-detector.js";
import "./consent-monitor.js";
import "./conversation-bridge.js";
import "./docker-runner.js";
import "./event-publisher.js";
import "./session-event-router.js";
import "./speaker-resolver.js";
import "./storage-writer.js";
import "./tts-bridge.js";
import "./tts-lipsync.js";

import {
  MEET_CHAT_MAX_LENGTH,
  trustedTypeHttpTimeoutMs,
} from "../contracts/native-messaging.js";
import { getMeetConfig } from "../meet-config.js";
import type { MeetAudioIngest } from "./audio-ingest.js";
import { AUDIO_INGEST_SUB_MODULE } from "./audio-ingest.js";
import type {
  BargeInCanceller,
  MeetBargeInWatcher,
  MeetBargeInWatcherDeps,
} from "./barge-in-watcher.js";
import type {
  ChatOpportunityCallback,
  ChatOpportunityDecision,
  ChatOpportunityDetectorStats,
  ChatOpportunityLLMAsk,
  MeetChatOpportunityDetector,
  MeetChatOpportunityDetectorDeps,
  ProactiveChatConfig,
  VoiceModeConfig,
} from "./chat-opportunity-detector.js";
import type {
  MeetConsentMonitor,
  MeetConsentMonitorDeps,
  MeetSessionLeaver,
} from "./consent-monitor.js";
import type {
  BuildConversationBridgeArgs,
  InsertMessageFn,
  MeetConversationBridge,
} from "./conversation-bridge.js";
import {
  DOCKER_RUNNER_MODULE,
  getMeetBotInstanceHash,
  MEET_BOT_INSTANCE_LABEL,
  MEET_BOT_LABEL,
  MEET_BOT_MEETING_ID_LABEL,
  reapOrphanedMeetBots,
} from "./docker-runner.js";
import type {
  DockerRunner,
  DockerRunResult,
  DockerWaitResult,
} from "./docker-runner.js";
import {
  meetEventDispatcher,
  publishMeetEvent,
  registerMeetingDispatcher,
  subscribeEventHubPublisher,
  subscribeToMeetingEvents,
  unregisterMeetingDispatcher,
} from "./event-publisher.js";
import type { MeetEventUnsubscribe } from "./event-publisher.js";
import { getSubModule, type SubModuleFactory } from "./modules-registry.js";
import { getMeetSessionEventRouter } from "./session-event-router.js";
import type { MeetStorageWriter, PcmSource } from "./storage-writer.js";
import { MeetTtsCancelledError } from "./tts-bridge.js";
import type {
  MeetTtsBridge,
  MeetTtsBridgeArgs,
  SpeakInput,
  VisemeListener,
} from "./tts-bridge.js";
import type { StartTtsLipsyncArgs, TtsLipsyncHandle } from "./tts-lipsync.js";

/**
 * Minimal structural overlay of the daemon's `ToolDefinition` used to
 * force the Tier 2 LLM into a strict-JSON response. The host's
 * `providers.llm` facet types its request arguments as `unknown`, so we
 * declare the local shape we actually need — keeping the concrete
 * daemon type out of this file.
 */
interface ToolDefinitionShape {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: readonly string[];
  };
}

/**
 * Narrow provider surface for the default Tier 2 LLM binding. The host's
 * `providers.llm.getConfigured()` returns an opaque `Provider`, which we
 * narrow here to the one `sendMessage` method this module calls.
 */
interface LlmProviderLike {
  sendMessage(
    messages: unknown[],
    tools: ToolDefinitionShape[],
    system: string,
    opts: {
      config: {
        callSite: string;
        max_tokens: number;
        tool_choice: { type: "tool"; name: string };
      };
      signal: AbortSignal;
    },
  ): Promise<unknown>;
}

/** Default internal port the bot's control API listens on inside the container. */
export const MEET_BOT_INTERNAL_PORT = 3000;

/** Default host interface to bind the bot's published port to. */
export const MEET_BOT_HOST_IP = "127.0.0.1";

/** Timeout for the best-effort bot `/leave` HTTP call before falling back to stop. */
export const BOT_LEAVE_HTTP_TIMEOUT_MS = 10_000;

/**
 * Floor for the bot `/send_chat` HTTP timeout. The per-request ceiling
 * scales with text length via {@link trustedTypeHttpTimeoutMs} — xdotool
 * types at 25ms/char inside the bot, so a 2000-char chat takes ~50s to
 * land before the extension can reply. The actual timeout applied per
 * request is `max(FLOOR, trustedTypeHttpTimeoutMs(text.length))`.
 */
export const BOT_SEND_CHAT_HTTP_TIMEOUT_MS = 10_000;

/**
 * Timeout for the bot `/avatar/enable` and `/avatar/disable` HTTP calls.
 * Enable can take several seconds when a heavy renderer (e.g. SadTalker)
 * is first spinning up, so we budget more generously than chat. Disable
 * is nearly instant in practice but shares the same ceiling so the two
 * lifecycle verbs are symmetric.
 */
export const BOT_AVATAR_HTTP_TIMEOUT_MS = 30_000;

/**
 * Shared deadline for tearing down every active Meet session during daemon
 * shutdown. Past this budget any remaining containers are force-stopped
 * directly and the session records are dropped so the next daemon start
 * lands on a clean slate.
 */
export const MEET_SHUTDOWN_DEADLINE_MS = 15_000;

/** Default daemon HTTP port when `RUNTIME_HTTP_PORT` is not set. */
const DEFAULT_DAEMON_PORT = 7821;

/** Tier 2 chat-opportunity LLM timeout — bounds the proactive-chat path. */
export const CHAT_OPPORTUNITY_LLM_TIMEOUT_MS = 5_000;

/** Tier 2 chat-opportunity LLM max tokens for the structured response. */
export const CHAT_OPPORTUNITY_LLM_MAX_TOKENS = 256;

/**
 * Fallback display name forwarded to the bot container when neither
 * `services.meet.joinName` nor `getAssistantName()` resolve a value. The
 * bot's `needsFullWiring` predicate requires a non-empty `JOIN_NAME`, so
 * this fallback keeps the full-join path reachable even on first boot
 * before `IDENTITY.md` has been written. Matches the tool-side fallback
 * in `skills/meet-join/tools/meet-join-tool.ts`.
 */
export const MEET_JOIN_NAME_FALLBACK = "Vellum";

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

/**
 * Thrown by session-manager methods (`sendChat`, `speak`, `enableAvatar`, etc.)
 * when no active session exists for the given meeting id. Callers (e.g. the
 * `meet_*` tools) match on this class to surface a targeted error rather
 * than a generic failure.
 */
export class MeetSessionNotFoundError extends Error {
  readonly name = "MeetSessionNotFoundError";

  constructor(meetingId: string) {
    super(`No active Meet session for meetingId=${meetingId}`);
  }
}

/**
 * Thrown by session-manager methods that hit the bot's control API when the
 * bot could not be reached (network error, timeout, container gone). Distinct
 * from {@link MeetBotChatError} / {@link MeetBotAvatarError} which represent
 * well-formed bot responses whose status indicates failure.
 */
export class MeetSessionUnreachableError extends Error {
  readonly name = "MeetSessionUnreachableError";

  constructor(meetingId: string, cause: string) {
    super(`Meet bot unreachable for meetingId=${meetingId}: ${cause}`);
  }
}

/**
 * Thrown by {@link MeetSessionManager.sendChat} when the bot responded with
 * a non-2xx status code — e.g. a 502 from an upstream Meet chat failure.
 * Preserves the status so tool-layer callers can relay a helpful message.
 */
export class MeetBotChatError extends Error {
  readonly name = "MeetBotChatError";
  readonly status: number;

  constructor(meetingId: string, status: number, detail: string) {
    super(
      `Meet bot /send_chat returned ${status} for meetingId=${meetingId}: ${detail}`,
    );
    this.status = status;
  }
}

/**
 * Thrown by {@link MeetSessionManager.enableAvatar} /
 * {@link MeetSessionManager.disableAvatar} when the bot responded with a
 * non-2xx status code — e.g. a 503 when the avatar subsystem is disabled
 * or the configured renderer is unavailable. Preserves the status code and
 * the raw body so tool-layer callers can relay a helpful message.
 */
export class MeetBotAvatarError extends Error {
  readonly name = "MeetBotAvatarError";
  readonly status: number;

  constructor(
    meetingId: string,
    endpoint: string,
    status: number,
    detail: string,
  ) {
    super(
      `Meet bot ${endpoint} returned ${status} for meetingId=${meetingId}: ${detail}`,
    );
    this.status = status;
  }
}

/**
 * Thrown by {@link MeetSessionManager.join} when the avatar feature is
 * enabled in `services.meet.avatar` but the configured v4l2loopback device
 * node is not present inside the daemon container.
 *
 * In Docker mode the CLI bind-mounts the host device into the assistant
 * container via `VELLUM_AVATAR_DEVICE`. If the avatar is enabled in config
 * but the device node is not present, the daemon's Docker Engine API
 * `--device` pass-through would otherwise fail much later with a cryptic
 * "device not found" error from the inner `dockerd`. This class surfaces
 * the root cause at meet-join time with an actionable message.
 *
 * Bare-metal mode does not raise this error because the device is expected
 * to exist on the host — if it does not, the operator is missing the
 * `v4l2loopback` kernel module entirely, which is a separate host-setup
 * problem outside this check's scope.
 */
export class MeetAvatarDeviceMissingError extends Error {
  readonly name = "MeetAvatarDeviceMissingError";
  readonly devicePath: string;

  constructor(devicePath: string) {
    super(
      `Meet avatar is enabled in services.meet.avatar but ${devicePath} is not present inside the assistant container. ` +
        `The CLI passes VELLUM_AVATAR_DEVICE to the container and bind-mounts the device when it exists on the host. ` +
        `Ensure the v4l2loopback module is loaded and the device path matches VELLUM_AVATAR_DEVICE (or services.meet.avatar.devicePath).`,
    );
    this.devicePath = devicePath;
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MeetSession {
  meetingId: string;
  conversationId: string;
  containerId: string;
  /** Host-side URL the daemon can use to talk to the bot's control API. */
  botBaseUrl: string;
  /** Per-meeting bearer token minted at join time. */
  botApiToken: string;
  /** Wall-clock ms since the epoch when the session was created. */
  startedAt: number;
  /** `services.meet.maxMeetingMinutes * 60_000` — captured at join time. */
  joinTimeoutMs: number;
}

export interface JoinInput {
  url: string;
  meetingId: string;
  conversationId: string;
  /**
   * Override for `services.meet.consentMessage`. When provided, this value is
   * forwarded to the bot container via `CONSENT_MESSAGE` instead of the raw
   * config template. Used by the `meet_join` tool (PR 23) to inject the
   * substituted `{assistantName}` value before the bot spawns.
   *
   * When omitted, the session manager falls back to the config template
   * verbatim — the bot itself will not perform template substitution, so
   * callers that need `{assistantName}` resolved must pass the substituted
   * string here.
   */
  consentMessage?: string;
}

// ---------------------------------------------------------------------------
// MeetSessionManagerImpl
// ---------------------------------------------------------------------------

interface ActiveSession extends MeetSession {
  /** Hard-cap timeout handle — cleared on leave. */
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  /**
   * The audio-ingest instance owning the Unix-socket server and streaming
   * STT session for this meeting. Created in `join()` and torn down in
   * `leave()` after the container is removed.
   */
  audioIngest: MeetAudioIngestLike;
  /** Unsubscribe handles for per-session dispatcher subscriptions. */
  eventUnsubscribes: MeetEventUnsubscribe[];
  /** True once the bot has emitted a `lifecycle.joined` event. */
  joinedPublished: boolean;
  /**
   * Consent monitor for this meeting — watches transcript/chat for
   * objection phrases and triggers auto-leave when confirmed by the LLM.
   * Started in `join()` and stopped at the very top of `leave()` so no
   * late event triggers a self-invoked leave while teardown is running.
   */
  consentMonitor: MeetConsentMonitorLike;
  /**
   * Conversation bridge — transforms bot events (transcripts, chat,
   * participant changes) into conversation messages. Subscribed in
   * `join()` and torn down in `leave()` before the dispatcher is
   * unregistered.
   */
  conversationBridge: MeetConversationBridgeLike;
  /**
   * Storage writer — persists `transcript.jsonl`, `segments.jsonl`,
   * `participants.json`, `meta.json`, and (via ffmpeg) `audio.opus` under
   * `<workspace>/meets/<meetingId>/`. Started in `join()` and stopped in
   * `leave()` after a synthesized `lifecycle:left` event is dispatched so
   * `meta.json` is flushed before the dispatcher is unregistered.
   */
  storageWriter: MeetStorageWriterLike;
  /**
   * Chat-opportunity detector — watches transcript and inbound chat for
   * proactive-response opportunities and fires
   * {@link wakeAgentForOpportunity} when Tier 1 + Tier 2 both confirm.
   * Constructed in `join()` only when
   * `services.meet.proactiveChat.enabled === true`; `null` otherwise.
   * Disposed in `leave()` before the dispatcher is unregistered.
   */
  chatOpportunityDetector: MeetChatOpportunityDetectorLike | null;
  /**
   * TTS-bridge for this meeting — drives {@link MeetSessionManager.speak}
   * and {@link MeetSessionManager.cancelSpeak}. Constructed in `join()`
   * after the bot's base URL is known, torn down via `cancelAll()` in
   * `leave()` so no orphan stream outlives the container.
   */
  ttsBridge: MeetTtsBridgeLike;
  /**
   * Forwarder that subscribes to {@link MeetTtsBridge.onViseme} and POSTs
   * each event to the bot's `/avatar/viseme` endpoint so the in-bot avatar
   * renderer drives blendshape weights against the audio the bot is
   * simultaneously playing out. Started in `join()` right after the TTS
   * bridge is constructed and stopped in `leave()` BEFORE
   * `ttsBridge.cancelAll()` so no late POSTs fire against a shutting-down
   * bridge. See {@link startTtsLipsync} for the forwarder's fire-and-forget
   * HTTP semantics.
   */
  ttsLipsyncHandle: TtsLipsyncHandle;
  /**
   * Barge-in watcher for this meeting — auto-cancels in-flight TTS when
   * a non-bot speaker takes the floor while the bot is mid-utterance.
   * Started in `join()` immediately after the session record is in place
   * and torn down in `leave()` before the dispatcher is unregistered.
   */
  bargeInWatcher: MeetBargeInWatcherLike;
  /**
   * True once the daemon's own `leave()` path has begun tearing the session
   * down. Used by the container-exit watcher to distinguish a
   * daemon-initiated shutdown (expected exit, session cleanup already in
   * flight) from an unexpected external death (e.g. `docker kill`, OOM
   * reaper, stray concurrent daemon reaping the container). On the
   * daemon-initiated path the watcher becomes a no-op; on the external
   * path it synthesizes a `meet.error`, mirror-tears session-scoped
   * resources, and drops the session so clients don't stay pinned in
   * "joined" forever. Set at the TOP of `leave()` before any awaits so a
   * race between the first teardown await and the engine-side exit
   * notification still flags the watcher correctly.
   */
  leaveInitiatedByDaemon: boolean;
}

/**
 * Thin interface for the audio-ingest surface the session manager uses.
 * Lets tests swap in a fake without needing the real STT/socket stack.
 *
 * `subscribePcm` provides the fan-out tap the storage writer consumes: each
 * PCM chunk arriving from the bot is delivered to every subscriber in
 * addition to being forwarded to the streaming STT session. Returning an
 * unsubscribe lets callers drop their tap without disturbing peers.
 */
export interface MeetAudioIngestLike {
  /**
   * Open the audio-ingest TCP server and streaming STT session.
   *
   * Returns `{ port, ready }` as soon as the server is bound — `port` is
   * the OS-assigned loopback port the session manager threads into the
   * bot container as `DAEMON_AUDIO_PORT`, and `ready` resolves once the
   * bot has actually connected (or rejects on timeout). Splitting the two
   * lets the container spawn run concurrently with the bot-connect wait.
   *
   * `botApiToken` is the same per-session token the session manager
   * threads into `BOT_API_TOKEN` for the bot container. The ingest
   * requires the bot to send `AUTH <token>\n` as the first bytes over
   * the TCP connection and destroys any peer that doesn't match — this
   * closes the hole opened by binding the audio server on
   * `0.0.0.0` (so Linux Docker bots can reach it via
   * `host.docker.internal:host-gateway`), which would otherwise let any
   * LAN-adjacent process inject PCM or stall the listener.
   */
  start(
    meetingId: string,
    botApiToken: string,
  ): Promise<{ port: number; ready: Promise<void> }>;
  stop(): Promise<void>;
  subscribePcm(cb: (bytes: Uint8Array) => void): () => void;
}

/**
 * Thin interface for the consent-monitor surface the session manager
 * uses. Lets tests swap in a fake without needing the real LLM stack.
 */
export interface MeetConsentMonitorLike {
  start(): void;
  stop(): void;
}

/**
 * Thin interface for the chat-opportunity detector surface the session
 * manager uses. Lets tests swap in a fake without needing the real LLM
 * stack or dispatcher subscription. Mirrors
 * {@link MeetChatOpportunityDetector} — `start` subscribes, `dispose`
 * unsubscribes, `getStats` exposes the running counters that `leave()`
 * emits as a per-meeting summary log line.
 */
export interface MeetChatOpportunityDetectorLike {
  start(): void;
  dispose(): void;
  getStats(): ChatOpportunityDetectorStats;
}

/**
 * Thin interface for the conversation bridge surface the session manager
 * uses. Lets tests swap in a fake without needing the real dispatcher
 * subscription + resolver stack.
 */
export interface MeetConversationBridgeLike {
  subscribe(): void;
  unsubscribe(): void;
}

/**
 * Thin interface for the storage writer surface the session manager uses.
 * The session manager drives `start()` / `startAudio(source)` / `stop()`
 * and the writer owns its own dispatcher subscription internally.
 */
export interface MeetStorageWriterLike {
  start(): void;
  startAudio(source: PcmSource): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Thin interface for the TTS-bridge surface the session manager uses. Lets
 * tests swap in a fake without spinning up ffmpeg or a real HTTP client.
 *
 * Includes the `onViseme` / `botBaseUrl` / `meetingId` surface consumed by
 * {@link startTtsLipsync} so a Like-only fake passed via
 * {@link MeetSessionManagerDeps.ttsBridgeFactory} remains compatible with
 * the default lipsync factory without an unsafe cast.
 */
export interface MeetTtsBridgeLike {
  readonly meetingId: string;
  readonly botBaseUrl: string;
  speak(
    input: SpeakInput,
  ): Promise<{ streamId: string; completion: Promise<void> }>;
  cancel(streamId: string): Promise<void>;
  cancelAll(): Promise<void>;
  activeStreamCount(): number;
  onViseme(listener: VisemeListener): () => void;
}

/**
 * Thin interface for the barge-in watcher surface the session manager
 * uses. Lets tests swap in a fake to observe `start`/`stop` without
 * spinning up the dispatcher + assistant-event-hub subscriptions. The
 * real {@link MeetBargeInWatcher} satisfies this naturally.
 */
export interface MeetBargeInWatcherLike {
  start(): void;
  stop(): void;
}

/** Arguments passed to {@link MeetSessionManagerDeps.consentMonitorFactory}. */
export interface MeetConsentMonitorFactoryArgs {
  meetingId: string;
  sessionManager: MeetSessionLeaver;
  config: { autoLeaveOnObjection: boolean; objectionKeywords: string[] };
}

/** Arguments passed to {@link MeetSessionManagerDeps.conversationBridgeFactory}. */
export interface MeetConversationBridgeFactoryArgs {
  meetingId: string;
  conversationId: string;
}

/** Arguments passed to {@link MeetSessionManagerDeps.storageWriterFactory}. */
export interface MeetStorageWriterFactoryArgs {
  meetingId: string;
}

/** Arguments passed to {@link MeetSessionManagerDeps.ttsBridgeFactory}. */
export interface MeetTtsBridgeFactoryArgs {
  meetingId: string;
  botBaseUrl: string;
  botApiToken: string;
}

/** Arguments passed to {@link MeetSessionManagerDeps.ttsLipsyncFactory}. */
export interface MeetTtsLipsyncFactoryArgs {
  bridge: MeetTtsBridgeLike;
  botApiToken: string;
  meetingId: string;
}

/** Arguments passed to {@link MeetSessionManagerDeps.bargeInWatcherFactory}. */
export interface MeetBargeInWatcherFactoryArgs {
  meetingId: string;
  sessionManager: BargeInCanceller;
}

/**
 * Arguments passed to
 * {@link MeetSessionManagerDeps.chatOpportunityDetectorFactory}.
 */
export interface MeetChatOpportunityDetectorFactoryArgs {
  meetingId: string;
  conversationId: string;
  assistantDisplayName: string;
  config: ProactiveChatConfig;
  voiceConfig: VoiceModeConfig;
  callDetectorLLM: ChatOpportunityLLMAsk;
  onOpportunity: ChatOpportunityCallback;
}

export interface MeetSessionManagerDeps {
  /** Factory for the Docker runner — swapped in tests. */
  dockerRunnerFactory?: () => Pick<
    DockerRunner,
    | "run"
    | "stop"
    | "remove"
    | "inspect"
    | "logs"
    | "kill"
    | "listContainers"
    | "wait"
  >;
  /** Override the function that fetches credentials. */
  getProviderKey?: (provider: string) => Promise<string | undefined>;
  /** Override the function that hits the bot's `/leave` endpoint. */
  botLeaveFetch?: (url: string, token: string) => Promise<void>;
  /**
   * Override the function that hits the bot's `/send_chat` endpoint.
   * Resolves on 2xx, throws {@link MeetBotChatError} on non-2xx, and throws
   * {@link MeetSessionUnreachableError} when the fetch itself fails (DNS,
   * connect refused, timeout, etc.).
   */
  botSendChatFetch?: (
    url: string,
    token: string,
    text: string,
    meetingId: string,
  ) => Promise<void>;
  /**
   * Override the function that hits the bot's `/avatar/enable` and
   * `/avatar/disable` endpoints. Resolves with the parsed JSON body on 2xx,
   * throws {@link MeetBotAvatarError} on non-2xx (e.g. 503 when the avatar
   * subsystem is disabled or the renderer is unavailable), and throws
   * {@link MeetSessionUnreachableError} when the fetch itself fails.
   */
  botAvatarFetch?: (
    url: string,
    token: string,
    endpoint: string,
    meetingId: string,
  ) => Promise<Record<string, unknown>>;
  /** Override the daemon-URL resolver (used for `DAEMON_URL` env var). */
  resolveDaemonUrl?: () => string;
  /** Override workspace directory resolution (tests). */
  getWorkspaceDir?: () => string;
  /**
   * Override the audio-ingest factory. Default constructs a
   * {@link MeetAudioIngest} with its own defaults.
   */
  audioIngestFactory?: () => MeetAudioIngestLike;
  /**
   * Override the consent-monitor factory. Default constructs a
   * {@link MeetConsentMonitor} with its own defaults. Tests can inject
   * a fake to observe `start`/`stop` without spinning up the LLM path.
   */
  consentMonitorFactory?: (
    args: MeetConsentMonitorFactoryArgs,
  ) => MeetConsentMonitorLike;
  /**
   * Override the conversation-bridge factory. Default constructs a
   * {@link MeetConversationBridge} wired to the production `addMessage`.
   * Tests can inject a fake (e.g. recording `insertMessage`) without
   * touching the real DB.
   */
  conversationBridgeFactory?: (
    args: MeetConversationBridgeFactoryArgs,
  ) => MeetConversationBridgeLike;
  /**
   * Override the storage-writer factory. Default constructs a
   * {@link MeetStorageWriter} pointed at the workspace meets directory.
   */
  storageWriterFactory?: (
    args: MeetStorageWriterFactoryArgs,
  ) => MeetStorageWriterLike;
  /**
   * Override the assistant-display-name resolver used as the `JOIN_NAME`
   * fallback when `services.meet.joinName` is null. Default reads
   * IDENTITY.md via {@link getAssistantName}.
   */
  resolveAssistantDisplayName?: () => string | null;
  /**
   * Override the `insertMessage` function passed to the default
   * conversation-bridge factory. Default wraps `addMessage` from the
   * conversation CRUD module.
   */
  insertMessage?: InsertMessageFn;
  /**
   * Override the chat-opportunity-detector factory. Default constructs a
   * {@link MeetChatOpportunityDetector} with a Tier 2 LLM callback that
   * routes through the repo-wide provider abstraction under the
   * `meetChatOpportunity` call site. Tests can inject a fake to observe
   * start/dispose/stats without spinning up the LLM path.
   *
   * Only consulted when `services.meet.proactiveChat.enabled === true`.
   */
  chatOpportunityDetectorFactory?: (
    args: MeetChatOpportunityDetectorFactoryArgs,
  ) => MeetChatOpportunityDetectorLike;
  /**
   * Override the TTS-bridge factory. Default constructs a
   * {@link MeetTtsBridge} that resolves the configured TTS provider via
   * the registry on each `speak` call. Tests can inject a fake to
   * observe speak/cancel without spinning up ffmpeg or a real HTTP
   * client.
   */
  ttsBridgeFactory?: (args: MeetTtsBridgeFactoryArgs) => MeetTtsBridgeLike;
  /**
   * Override the TTS lip-sync forwarder factory. Default invokes
   * {@link startTtsLipsync} to subscribe the bridge's `onViseme` channel
   * and POST each event to the bot's `/avatar/viseme` endpoint. Tests can
   * inject a fake that returns a handle whose `stop()` is observed without
   * needing the bridge or bot to exist.
   */
  ttsLipsyncFactory?: (args: MeetTtsLipsyncFactoryArgs) => TtsLipsyncHandle;
  /**
   * Override the barge-in watcher factory. Default constructs a
   * {@link MeetBargeInWatcher} that subscribes to the meeting's
   * dispatcher and the {@link assistantEventHub} for `meet.speaking_*`
   * events. Tests can inject a fake to observe `start`/`stop` without
   * spinning up the subscription stack.
   */
  bargeInWatcherFactory?: (
    args: MeetBargeInWatcherFactoryArgs,
  ) => MeetBargeInWatcherLike;
  /**
   * Override the function the session manager calls to wake the agent
   * loop when the detector fires an opportunity. Default routes through
   * the runtime-level {@link wakeAgentForOpportunity} using the
   * process-wide default resolver installed by the daemon startup.
   *
   * Tests can inject a spy to observe the wake payload without touching
   * the real conversation registry.
   */
  wakeAgent?: (opts: {
    conversationId: string;
    hint: string;
    source: string;
  }) => Promise<void>;
  /**
   * Override the daemon runtime-mode resolver. Defaults to
   * {@link getDaemonRuntimeMode}. Only consulted by the avatar-device
   * preflight in {@link MeetSessionManager.join}; tests inject a fixed
   * value to exercise the Docker-mode branch without touching
   * `IS_CONTAINERIZED`.
   */
  resolveRuntimeMode?: () => DaemonRuntimeMode;
  /**
   * Override the avatar-device existence check. Defaults to
   * {@link existsSync}. Used by the preflight in
   * {@link MeetSessionManager.join} so tests can simulate a missing
   * `/dev/video10` without needing the device to actually not exist (or
   * worse, to exist) on the test machine.
   */
  avatarDeviceExists?: (path: string) => boolean;
  /**
   * Disables the one-shot startup orphan-reaper sweep. Only used by unit
   * tests that don't want a background reaper call polluting docker-client
   * mocks. Production and integration paths leave this as the default
   * (sweep enabled).
   */
  disableStartupOrphanReaper?: boolean;
}

class MeetSessionManagerImpl {
  private sessions = new Map<string, ActiveSession>();
  /** True while {@link shutdownAll} is in progress — blocks new joins. */
  private shuttingDown = false;
  /**
   * Bot API tokens for sessions whose container has been spawned but whose
   * full {@link ActiveSession} record has not yet been inserted into
   * {@link sessions} (that insertion only happens after the audio-ingest
   * handshake completes). The meet-internal events route needs the token
   * resolver to answer the moment the bot's {@link DaemonClient} starts
   * POSTing `lifecycle:joining` — which happens long before the session
   * lands in `sessions`, so we register the token here as soon as we mint
   * it and delete once the session is in `sessions` (or the join rolls
   * back). Without this, early bot events get 401s, the bot's terminal-
   * error handler trips, and the bot shuts down before it ever reaches
   * the audio-socket connect or the meet "Ask to join" click.
   */
  private pendingBotTokens = new Map<string, string>();
  /**
   * Device paths that have already passed the Docker-mode avatar preflight
   * in {@link join}. Cached per-daemon so a repeated join with the same
   * `services.meet.avatar.devicePath` does not re-stat the filesystem —
   * device nodes do not disappear across join calls in practice, and the
   * check is expected to be a no-op on the happy path. A Set keyed on the
   * device path keeps the cache correct if an operator reconfigures
   * `services.meet.avatar.devicePath` at runtime.
   */
  private avatarPreflightPassedPaths = new Set<string>();
  private deps: Required<MeetSessionManagerDeps>;
  private host: SkillHost;
  private log: Logger;

  constructor(host: SkillHost, deps: MeetSessionManagerDeps = {}) {
    this.host = host;
    this.log = host.logger.get("meet-session-manager");
    // The contract's `addMessage` returns `Promise<unknown>`; the bridge's
    // `InsertMessageFn` expects the narrower `{ id: string }` shape.
    // `DaemonSkillHost` wires the concrete `addMessage` (which returns the
    // narrower shape) as-is, so the runtime values match — the narrowing
    // cast just patches the contract's opaque return type back to the
    // daemon shape at this boundary.
    const insertMessage: InsertMessageFn =
      deps.insertMessage ?? (host.memory.addMessage as InsertMessageFn);
    const resolveWorkspaceDir =
      deps.getWorkspaceDir ?? (() => host.platform.workspaceDir());
    const dockerRunnerSubModule =
      resolveSubModuleFactory<
        (host: SkillHost, resolveWorkspaceDir?: () => string) => DockerRunner
      >(DOCKER_RUNNER_MODULE);
    const audioIngestSubModule = resolveSubModuleFactory<
      (host: SkillHost) => () => MeetAudioIngest
    >(AUDIO_INGEST_SUB_MODULE);
    const consentMonitorSubModule = resolveSubModuleFactory<
      (host: SkillHost) => (
        deps: Omit<MeetConsentMonitorDeps, "assistantId"> & {
          assistantId?: string;
        },
      ) => MeetConsentMonitor
    >("consent-monitor");
    const conversationBridgeSubModule = resolveSubModuleFactory<
      (
        host: SkillHost,
      ) => (args: BuildConversationBridgeArgs) => MeetConversationBridge
    >("conversation-bridge");
    const storageWriterSubModule =
      resolveSubModuleFactory<
        (
          host: SkillHost,
          resolveWorkspaceDir?: () => string,
        ) => (meetingId: string) => MeetStorageWriter
      >("storage-writer");
    const chatOpportunityDetectorSubModule = resolveSubModuleFactory<
      (
        host: SkillHost,
      ) => (
        deps: MeetChatOpportunityDetectorDeps,
      ) => MeetChatOpportunityDetector
    >("chat-opportunity-detector");
    const ttsBridgeSubModule =
      resolveSubModuleFactory<
        (host: SkillHost) => (args: MeetTtsBridgeArgs) => MeetTtsBridge
      >("tts-bridge");
    const ttsLipsyncSubModule =
      resolveSubModuleFactory<
        (host: SkillHost) => (args: StartTtsLipsyncArgs) => TtsLipsyncHandle
      >("tts-lipsync");
    const bargeInWatcherSubModule =
      resolveSubModuleFactory<
        (
          host: SkillHost,
        ) => (deps: MeetBargeInWatcherDeps) => MeetBargeInWatcher
      >("barge-in-watcher");

    const dockerRunnerBuilder = (): DockerRunner =>
      dockerRunnerSubModule(host, resolveWorkspaceDir);
    const audioIngestBuilder = audioIngestSubModule(host);
    const consentMonitorBuilder = consentMonitorSubModule(host);
    const conversationBridgeBuilder = conversationBridgeSubModule(host);
    const storageWriterBuilder = storageWriterSubModule(
      host,
      resolveWorkspaceDir,
    );
    const chatOpportunityDetectorBuilder =
      chatOpportunityDetectorSubModule(host);
    const ttsBridgeBuilder = ttsBridgeSubModule(host);
    const ttsLipsyncBuilder = ttsLipsyncSubModule(host);
    const bargeInWatcherBuilder = bargeInWatcherSubModule(host);

    this.deps = {
      dockerRunnerFactory: deps.dockerRunnerFactory ?? dockerRunnerBuilder,
      getProviderKey:
        deps.getProviderKey ??
        (async (id) =>
          (await host.providers.secureKeys.getProviderKey(id)) ?? undefined),
      botLeaveFetch: deps.botLeaveFetch ?? defaultBotLeaveFetch,
      botSendChatFetch: deps.botSendChatFetch ?? defaultBotSendChatFetch,
      botAvatarFetch: deps.botAvatarFetch ?? defaultBotAvatarFetch,
      resolveDaemonUrl: deps.resolveDaemonUrl ?? defaultResolveDaemonUrl,
      getWorkspaceDir: resolveWorkspaceDir,
      audioIngestFactory: deps.audioIngestFactory ?? audioIngestBuilder,
      consentMonitorFactory:
        deps.consentMonitorFactory ??
        ((args) =>
          consentMonitorBuilder({
            meetingId: args.meetingId,
            sessionManager: args.sessionManager,
            config: args.config,
          })),
      conversationBridgeFactory:
        deps.conversationBridgeFactory ??
        ((args) =>
          conversationBridgeBuilder({
            meetingId: args.meetingId,
            conversationId: args.conversationId,
            insertMessage,
          })),
      storageWriterFactory:
        deps.storageWriterFactory ??
        ((args) => storageWriterBuilder(args.meetingId)),
      resolveAssistantDisplayName:
        deps.resolveAssistantDisplayName ??
        (() => host.identity.getAssistantName() ?? null),
      insertMessage,
      chatOpportunityDetectorFactory:
        deps.chatOpportunityDetectorFactory ??
        ((args) =>
          chatOpportunityDetectorBuilder({
            meetingId: args.meetingId,
            assistantDisplayName: args.assistantDisplayName,
            config: args.config,
            voiceConfig: args.voiceConfig,
            callDetectorLLM: args.callDetectorLLM,
            onOpportunity: args.onOpportunity,
          })),
      ttsBridgeFactory:
        deps.ttsBridgeFactory ??
        ((args) =>
          ttsBridgeBuilder({
            meetingId: args.meetingId,
            botBaseUrl: args.botBaseUrl,
            botApiToken: args.botApiToken,
          })),
      ttsLipsyncFactory:
        deps.ttsLipsyncFactory ??
        ((args) =>
          ttsLipsyncBuilder({
            bridge: args.bridge,
            botApiToken: args.botApiToken,
          })),
      bargeInWatcherFactory:
        deps.bargeInWatcherFactory ??
        ((args) =>
          bargeInWatcherBuilder({
            meetingId: args.meetingId,
            sessionManager: args.sessionManager,
          })),
      wakeAgent:
        deps.wakeAgent ?? ((opts) => host.memory.wakeAgentForOpportunity(opts)),
      resolveRuntimeMode:
        deps.resolveRuntimeMode ?? (() => host.platform.runtimeMode()),
      avatarDeviceExists: deps.avatarDeviceExists ?? existsSync,
      disableStartupOrphanReaper: deps.disableStartupOrphanReaper ?? false,
    };

    // The ingress route (PR 9) looks up per-meeting tokens through this
    // resolver. Install it once at construction time — it reads live state
    // from `this.sessions` (and {@link pendingBotTokens} during the
    // container-spawn / audio-ingest window, before the session lands in
    // `sessions`), so it stays correct as sessions come and go.
    getMeetSessionEventRouter().setBotApiTokenResolver((meetingId) => {
      const session = this.sessions.get(meetingId);
      if (session) return session.botApiToken;
      return this.pendingBotTokens.get(meetingId) ?? null;
    });

    // One-shot startup orphan sweep. Any `vellum.meet.bot`-labeled container
    // still running came from a crashed prior daemon run and must be
    // reaped. Fire-and-forget so construction stays synchronous; the
    // reaper logs its own outcome and catches per-container errors so a
    // transient docker-engine hiccup never tears down the session-manager
    // singleton. Tests opt out via {@link MeetSessionManagerDeps.disableStartupOrphanReaper}.
    //
    // Three guards make the sweep race-safe with concurrent joins and
    // safe against cross-instance kills:
    //   1. `createdBefore` — Docker's `Created` timestamp for every
    //      container the reaper considers must predate this moment, so any
    //      container spawned by a join that races the sweep is skipped.
    //   2. `activeMeetingIds` — passed as a live getter that reads
    //      `this.sessions` (and `pendingBotTokens` for the brief window
    //      before the session lands in the map) per-container, so a join
    //      that lands mid-sweep is observed before its meeting ID is
    //      evaluated.
    //   3. `instanceHash` — derived from `vellumRoot()`, the daemon's
    //      per-instance data root. Multi-instance setups (prod/dev/test/
    //      local side-by-side) are common; without this guard a second
    //      daemon's startup reaper would SIGTERM the first daemon's live
    //      bot containers. Only same-instance bots are reaped.
    if (!this.deps.disableStartupOrphanReaper) {
      const reaperDocker = this.deps.dockerRunnerFactory();
      const daemonStartEpochSeconds = Math.floor(Date.now() / 1000);
      const reaperLog = this.log;
      void reapOrphanedMeetBots({
        docker: reaperDocker,
        activeMeetingIds: () => {
          const ids = new Set<string>(this.sessions.keys());
          for (const id of this.pendingBotTokens.keys()) ids.add(id);
          return ids;
        },
        instanceHash: getMeetBotInstanceHash(),
        createdBefore: daemonStartEpochSeconds,
        logger: reaperLog,
      }).catch((err: unknown) => {
        reaperLog.warn("Startup orphan-reaper sweep threw — continuing", {
          err,
        });
      });
    }
  }

  /** Reset internal state. Tests only. */
  _resetForTests(): void {
    for (const session of this.sessions.values()) {
      if (session.timeoutHandle) clearTimeout(session.timeoutHandle);
      for (const unsubscribe of session.eventUnsubscribes) {
        try {
          unsubscribe();
        } catch {
          /* best-effort */
        }
      }
      try {
        session.consentMonitor.stop();
      } catch {
        /* best-effort */
      }
      try {
        session.conversationBridge.unsubscribe();
      } catch {
        /* best-effort */
      }
      try {
        void session.storageWriter.stop();
      } catch {
        /* best-effort */
      }
      try {
        session.chatOpportunityDetector?.dispose();
      } catch {
        /* best-effort */
      }
      try {
        session.ttsLipsyncHandle.stop();
      } catch {
        /* best-effort */
      }
      try {
        void session.ttsBridge.cancelAll();
      } catch {
        /* best-effort */
      }
      try {
        session.bargeInWatcher.stop();
      } catch {
        /* best-effort */
      }
    }
    this.sessions.clear();
    this.pendingBotTokens.clear();
    this.avatarPreflightPassedPaths.clear();
  }

  /**
   * Preflight check invoked from {@link join} when the avatar feature is
   * enabled. In Docker mode, verifies that the configured v4l2loopback
   * device node is present inside the daemon container — the CLI
   * (`cli/src/lib/docker.ts`) bind-mounts it via `VELLUM_AVATAR_DEVICE`.
   * If the device is not present, the downstream `DockerRunner.run()`
   * would fail with a cryptic "device not found" error from the inner
   * `dockerd`. This check moves the failure to a deterministic point
   * (meet-join time) with a clear message.
   *
   * In bare-metal mode the check is skipped — the device is expected to
   * exist on the host, and if it does not the operator is missing the
   * `v4l2loopback` kernel module entirely (a separate host-setup problem
   * outside this check's scope). Callers where `avatar.enabled` is false
   * should not reach this method.
   *
   * Results are cached in {@link avatarPreflightPassedPaths} so a repeated
   * join with the same device path does not re-stat the filesystem.
   */
  private assertAvatarDeviceAvailable(devicePath: string): void {
    if (this.deps.resolveRuntimeMode() !== "docker") return;
    if (this.avatarPreflightPassedPaths.has(devicePath)) return;
    if (!this.deps.avatarDeviceExists(devicePath)) {
      throw new MeetAvatarDeviceMissingError(devicePath);
    }
    this.avatarPreflightPassedPaths.add(devicePath);
  }

  /**
   * Spawn a Meet-bot container for the given meeting and return the session
   * descriptor. Throws if a session for the same meeting already exists.
   */
  async join(input: JoinInput): Promise<MeetSession> {
    const { url, meetingId, conversationId, consentMessage } = input;

    if (this.shuttingDown) {
      throw new Error(
        "MeetSessionManager is shutting down — new joins are not accepted",
      );
    }

    if (this.sessions.has(meetingId)) {
      throw new Error(
        `MeetSession already exists for meetingId=${meetingId}; leave the existing session before re-joining`,
      );
    }

    // Fire `meet.joining` before we start real work so clients can show the
    // "attempting to join …" state immediately. Await the publish so any
    // subscriber errors surface into the log stream before the container
    // spin-up (which takes seconds) begins.
    await publishMeetEvent(meetingId, "meet.joining", { url });

    let meet: ReturnType<typeof getMeetConfig>;
    let workspaceDir: string;
    let meetingDir: string;
    let outDir: string;
    let botApiToken: string;
    let ttsKey: string;
    try {
      workspaceDir = this.deps.getWorkspaceDir();
      meet = getMeetConfig(workspaceDir);

      // Preflight: verify the avatar device node is present before
      // letting the inner `dockerd` reject the bot-container create
      // with an opaque "device not found" error.
      if (meet.avatar.enabled) {
        this.assertAvatarDeviceAvailable(meet.avatar.devicePath);
      }

      meetingDir = join(workspaceDir, "meets", meetingId);
      outDir = join(meetingDir, "out");
      mkdirSync(outDir, { recursive: true });

      botApiToken = generateBotApiToken();
      // Pre-register the token so `/v1/internal/meet/:id/events` can
      // authenticate the bot's earliest `lifecycle:joining` POST — which
      // fires before the `ActiveSession` record lands in `this.sessions`
      // (that happens only after the audio-ingest handshake completes).
      // Cleared on every join-rollback path below and replaced by the
      // authoritative `this.sessions` lookup once the session is in the map.
      this.pendingBotTokens.set(meetingId, botApiToken);
    } catch (err) {
      // Best-effort cleanup: pendingBotTokens.delete is a no-op if the
      // set() line was never reached (e.g. getMeetConfig/mkdirSync threw).
      this.pendingBotTokens.delete(meetingId);
      void publishMeetEvent(meetingId, "meet.error", {
        detail: errorDetail(err),
      });
      throw err;
    }

    try {
      // Placeholder — Phase 3 (PR 23+) will resolve the real TTS credential.
      ttsKey = (await this.deps.getProviderKey("tts")) ?? "";
    } catch (err) {
      void publishMeetEvent(meetingId, "meet.error", {
        detail: errorDetail(err),
      });
      this.pendingBotTokens.delete(meetingId);
      throw err;
    }

    let daemonUrl: string;
    let effectiveJoinName: string;
    let resolvedConsentMessage: string;
    try {
      daemonUrl = this.deps.resolveDaemonUrl();

      // Resolve the effective bot display name. Priority:
      //   1. `services.meet.joinName` when set.
      //   2. The assistant display name from IDENTITY.md.
      //   3. {@link MEET_JOIN_NAME_FALLBACK} — guarantees a non-empty string
      //      so the bot's `needsFullWiring` predicate never silently downgrades
      //      the container to screenshot-only mode.
      // The same value is used for `JOIN_NAME` AND for `{assistantName}`
      // substitution in the consent message — the bot needs both.
      effectiveJoinName =
        meet.joinName ??
        this.deps.resolveAssistantDisplayName() ??
        MEET_JOIN_NAME_FALLBACK;

      // `{assistantName}` substitution is owned by the `meet_join` tool
      // (PR 23), which resolves the assistant name from IDENTITY.md and
      // passes a substituted string via `input.consentMessage`. Callers that
      // bypass the tool (direct API users, tests) pass the raw template —
      // substitute here so the bot receives a human-readable greeting
      // regardless of entry point.
      resolvedConsentMessage = substituteAssistantName(
        consentMessage ?? meet.consentMessage,
        effectiveJoinName,
      );
    } catch (err) {
      this.pendingBotTokens.delete(meetingId);
      void publishMeetEvent(meetingId, "meet.error", {
        detail: errorDetail(err),
      });
      throw err;
    }

    // Register the dispatcher BEFORE the audio-ingest starts so transcripts
    // fired by Deepgram the instant the streaming session opens cannot race
    // ahead of the router handler and end up in the "dropping event for
    // unregistered meeting" path. The ingest opens the STT session as part
    // of `start()`, which may begin emitting partials immediately.
    registerMeetingDispatcher(meetingId);

    // Audio ingest first, container spawn second:
    //   1. The ingest opens a streaming STT session (provider resolved
    //      from `services.stt.provider` via the provider catalog) and
    //      binds a loopback TCP port. Resolves with `{ port, ready }` as
    //      soon as the server is listening.
    //   2. The container is spawned with `DAEMON_AUDIO_PORT=<port>` in
    //      its env so the bot knows where to dial.
    //   3. Container spawn and the bot-connect wait (`ready`) run
    //      concurrently — spawn typically dominates (seconds) while the
    //      bot's in-browser join flow takes up to 120s.
    //
    // The port phase is synchronous-ish (STT handshake + TCP bind,
    // normally ~200ms), so the concurrency loss vs. the old "kick ingest
    // + container in parallel" path is negligible. A failure here
    // (e.g. {@link MeetAudioIngestError} when no streaming-capable STT
    // provider is configured) fails fast before we spend time spinning up
    // a container.
    const audioIngest = this.deps.audioIngestFactory();
    let audioIngestReady: Promise<void>;
    let audioPort: number;
    try {
      const handle = await audioIngest.start(meetingId, botApiToken);
      audioPort = handle.port;
      audioIngestReady = handle.ready;
    } catch (err) {
      unregisterMeetingDispatcher(meetingId);
      this.pendingBotTokens.delete(meetingId);
      void publishMeetEvent(meetingId, "meet.error", {
        detail: errorDetail(err),
      });
      throw err;
    }
    // Guard the ready promise immediately so a rejection between here and
    // the first explicit `await audioIngestReady` (after `runner.run()`)
    // does not surface as an unhandled rejection. The global handler in
    // `shutdown-handlers.ts` calls `process.exit(1)` on unhandled
    // rejections, so without this guard a transient bot-connect failure
    // during container spawn would crash the entire daemon.
    audioIngestReady.catch(() => {});

    const env: Record<string, string> = {
      MEET_URL: url,
      MEETING_ID: meetingId,
      // `JOIN_NAME` must be non-empty for the bot to take the full-wiring
      // branch (see `skills/meet-join/bot/src/main.ts:needsFullWiring`). Priority is:
      // services.meet.joinName → assistant display name → fallback.
      JOIN_NAME: effectiveJoinName,
      // Consent message with `{assistantName}` substituted using the same
      // effective display name the bot announces itself as.
      CONSENT_MESSAGE: resolvedConsentMessage,
      DAEMON_URL: daemonUrl,
      BOT_API_TOKEN: botApiToken,
      // Loopback TCP port the daemon's audio-ingest server bound. The bot
      // dials `host.docker.internal:<port>` to stream PCM. Unix sockets
      // over a bind mount are not usable here — Docker Desktop on macOS
      // rejects connect() across the host↔VM VirtioFS boundary.
      DAEMON_AUDIO_PORT: String(audioPort),
      // STT credentials live on the daemon, not the bot — the bot just
      // streams raw PCM and the daemon forwards it to the configured
      // streaming STT provider.
      TTS_API_KEY: ttsKey,
      // Enable the in-container Pulse null-sink by default (set to "1" to
      // disable in dev). Match the meet-bot image expectation.
      SKIP_PULSE: "0",
    };

    // Avatar config → bot env.
    //
    // When the avatar feature is enabled we thread the config down to the
    // bot via four env vars:
    //
    //   - `AVATAR_ENABLED` — flips the bot's Chrome flags into
    //     v4l2loopback mode (added in PR 3) and mounts the `/avatar/*`
    //     HTTP surface.
    //   - `AVATAR_RENDERER` — which factory the bot's registry resolves.
    //   - `AVATAR_CONFIG_JSON` — the full config block, serialized as a
    //     single JSON string so renderer-specific sub-objects flow through
    //     without having to explode each one into its own env var.
    //   - `AVATAR_DEVICE_PATH` — explicit device-node override the bot
    //     passes through to its Chrome launcher and `/avatar/enable`
    //     handler.
    //
    // Credential IDs in `services.meet.avatar.*CredentialId` fields are
    // passed through as-is by the `JSON.stringify(meet.avatar)` below —
    // this code does NOT resolve them to raw secrets. Today this is inert
    // because the only shipping renderers (`noop`, `talking-head`) have no
    // credential fields. TODO — when hosted-renderer PRs (Simli/HeyGen/
    // Tavus) land, they MUST extend this serialization step to resolve
    // `*CredentialId` values via the vault and substitute raw secrets
    // into the config before stringifying. The bot has no vault access
    // and will fail to reach hosted APIs otherwise. Do not ship a hosted
    // renderer without first extending this.
    if (meet.avatar.enabled) {
      env.AVATAR_ENABLED = "1";
      env.AVATAR_RENDERER = meet.avatar.renderer;
      env.AVATAR_CONFIG_JSON = JSON.stringify(meet.avatar);
      env.AVATAR_DEVICE_PATH = meet.avatar.devicePath;
    }

    const runner = this.deps.dockerRunnerFactory();

    let runResult: DockerRunResult;
    try {
      runResult = await runner.run({
        image: meet.containerImage,
        env,
        // Logical workspace-rooted mounts. DockerRunner resolves each one
        // to either a host-path bind (bare-metal mode) or a named-volume
        // subpath mount (Docker mode) based on the daemon's runtime mode.
        // Session-manager stays mode-agnostic.
        workspaceMounts: [
          { target: "/out", subpath: `meets/${meetingId}/out` },
        ],
        ports: [
          {
            hostIp: MEET_BOT_HOST_IP,
            hostPort: 0,
            containerPort: MEET_BOT_INTERNAL_PORT,
            protocol: "tcp",
          },
        ],
        name: `vellum-meet-${meetingId}`,
        network: meet.dockerNetwork,
        // Labels consumed by the orphan reaper on the next daemon boot.
        // See {@link reapOrphanedMeetBots} in `docker-runner.ts` for the
        // full label scheme + reaper contract. The `vellum.meet.instance`
        // label scopes the bot to this daemon's instance root so a
        // concurrently-running second daemon cannot reap this container.
        labels: {
          [MEET_BOT_LABEL]: "true",
          [MEET_BOT_MEETING_ID_LABEL]: meetingId,
          [MEET_BOT_INSTANCE_LABEL]: getMeetBotInstanceHash(),
        },
        // When avatar is enabled, pass through the v4l2loopback device so
        // the bot container can open `/dev/video10` (or whatever override
        // the user configured) as a character device and push frames into
        // it. The CLI (`cli/src/lib/docker.ts`) is responsible for
        // bind-mounting the host device into the assistant container in
        // Docker mode; this daemon-side wiring threads it one more hop to
        // the bot container.
        ...(meet.avatar.enabled
          ? { avatarDevicePath: meet.avatar.devicePath }
          : {}),
      });
    } catch (err) {
      this.log.error("Failed to spawn meet bot container", {
        err,
        meetingId,
        image: meet.containerImage,
      });
      // Tear down the concurrently-started audio ingest so we don't leak
      // a listening socket or a streaming STT session on the spawn-failure path.
      await audioIngest.stop().catch(() => {});
      unregisterMeetingDispatcher(meetingId);
      this.pendingBotTokens.delete(meetingId);
      void publishMeetEvent(meetingId, "meet.error", {
        detail: errorDetail(err),
      });
      throw err;
    }

    const boundPort = runResult.boundPorts.find(
      (p) => p.containerPort === MEET_BOT_INTERNAL_PORT,
    );
    if (!boundPort) {
      // Roll back the container so we don't leak a started-but-unreachable
      // bot. Best-effort — surface the original error either way.
      await captureBotLogs(runner, runResult.containerId, meetingDir, this.log);
      await runner.remove(runResult.containerId).catch(() => {});
      await audioIngest.stop().catch(() => {});
      unregisterMeetingDispatcher(meetingId);
      this.pendingBotTokens.delete(meetingId);
      const detail = `meet-bot container ${runResult.containerId} did not publish a host port for ${MEET_BOT_INTERNAL_PORT}/tcp`;
      void publishMeetEvent(meetingId, "meet.error", { detail });
      throw new Error(detail);
    }

    // Now that the container is up, wait for the bot to dial our loopback
    // TCP port. If it fails to connect within {@link BOT_CONNECT_TIMEOUT_MS}
    // the promise rejects and we roll the container back before re-throwing.
    // The error's `message` is forwarded to the caller via both the
    // `throw` and the `meet.error` event.
    try {
      await audioIngestReady;
    } catch (err) {
      this.log.error(
        "Meet audio ingest failed to start — rolling back container",
        { err, meetingId, containerId: runResult.containerId },
      );
      await runner.stop(runResult.containerId).catch(() => {});
      await captureBotLogs(runner, runResult.containerId, meetingDir, this.log);
      await runner.remove(runResult.containerId).catch(() => {});
      await audioIngest.stop().catch(() => {});
      unregisterMeetingDispatcher(meetingId);
      this.pendingBotTokens.delete(meetingId);
      void publishMeetEvent(meetingId, "meet.error", {
        detail: errorDetail(err),
      });
      throw err;
    }

    const botBaseUrl = `http://${MEET_BOT_HOST_IP}:${boundPort.hostPort}`;
    const joinTimeoutMs = meet.maxMeetingMinutes * 60_000;

    // Consent monitor is constructed before the session record so it can
    // be torn down deterministically from `leave()` — it subscribes on
    // `start()` below, after the session is in the map.
    const consentMonitor = this.deps.consentMonitorFactory({
      meetingId,
      sessionManager: this,
      config: {
        autoLeaveOnObjection: meet.autoLeaveOnObjection,
        objectionKeywords: [...meet.objectionKeywords],
      },
    });

    // Conversation bridge routes transcript / chat / participant events
    // into the target conversation.
    const conversationBridge = this.deps.conversationBridgeFactory({
      meetingId,
      conversationId,
    });

    // Storage writer persists on-disk artifacts under
    // `<workspace>/meets/<meetingId>/`.
    const storageWriter = this.deps.storageWriterFactory({ meetingId });

    // Chat-opportunity detector — proactively watches transcript/chat for
    // moments where the assistant chiming in via meeting chat would help,
    // and wakes the agent loop on positive Tier 2 verdicts. The detector
    // also hosts the 1:1 voice-mode EOU path, which is independently
    // gated from proactive chat. Construct it whenever EITHER feature is
    // enabled so disabling proactive chat does not silently disable
    // voice mode. When both are off, leaving the detector null means
    // zero lifecycle overhead and no event-handler cost on the
    // dispatcher path.
    const proactiveChatConfig = meet.proactiveChat;
    const voiceModeConfig = meet.voiceMode;
    const chatOpportunityDetector: MeetChatOpportunityDetectorLike | null =
      proactiveChatConfig.enabled || voiceModeConfig.enabled
        ? this.deps.chatOpportunityDetectorFactory({
            meetingId,
            conversationId,
            assistantDisplayName: effectiveJoinName,
            config: {
              enabled: proactiveChatConfig.enabled,
              detectorKeywords: [...proactiveChatConfig.detectorKeywords],
              tier2DebounceMs: proactiveChatConfig.tier2DebounceMs,
              escalationCooldownSec: proactiveChatConfig.escalationCooldownSec,
              tier2MaxTranscriptSec: proactiveChatConfig.tier2MaxTranscriptSec,
            },
            voiceConfig: {
              enabled: voiceModeConfig.enabled,
              eouDebounceMs: voiceModeConfig.eouDebounceMs,
            },
            callDetectorLLM: (prompt) => this.callDetectorLLM(prompt),
            onOpportunity: ({ reason, kind }) => {
              // `kind` distinguishes chat-opportunity wakes (Tier 2
              // positive verdict) from 1:1 voice-turn wakes. Thread it
              // through as a distinct `source` so downstream telemetry
              // and any future agent-side routing can branch on it.
              const source =
                kind === "voice" ? "meet-voice-turn" : "meet-chat-opportunity";
              void this.deps
                .wakeAgent({
                  conversationId,
                  hint: reason,
                  source,
                })
                .catch((err) => {
                  this.log.warn(
                    "MeetChatOpportunityDetector: wakeAgent rejected — dropping opportunity",
                    { err, meetingId, conversationId, kind },
                  );
                });
            },
          })
        : null;

    // TTS bridge — streams synthesized speech into the bot's /play_audio
    // endpoint. Resolved lazily per speak call so config-live provider
    // changes propagate.
    const ttsBridge = this.deps.ttsBridgeFactory({
      meetingId,
      botBaseUrl,
      botApiToken,
    });

    // TTS lip-sync forwarder — subscribes to the bridge's viseme channel
    // and POSTs each event to the bot's `/avatar/viseme` endpoint so the
    // in-bot avatar renderer drives mouth blendshapes against the audio
    // the bot is simultaneously playing out. Must be constructed AFTER
    // the bridge (it subscribes synchronously in `startTtsLipsync`) and
    // BEFORE any speak() call can land — since all speaks are gated on
    // the session record hitting `this.sessions`, wiring it here (before
    // the session is inserted) guarantees the tap is in place when the
    // first speak fires. Its handle lives on the ActiveSession so
    // `leave()` can stop the forwarder BEFORE the bridge is torn down.
    const ttsLipsyncHandle = this.deps.ttsLipsyncFactory({
      bridge: ttsBridge,
      botApiToken,
      meetingId,
    });

    // Barge-in watcher — auto-cancels in-flight TTS when a non-bot speaker
    // takes the floor mid-utterance. Subscribes to the dispatcher and the
    // assistant-event-hub for `meet.speaking_*` lifecycle. Constructed
    // before the session record is in place so the field is non-null on
    // first read; `start()` runs below alongside the other subscribers.
    const bargeInWatcher = this.deps.bargeInWatcherFactory({
      meetingId,
      sessionManager: this,
    });

    const startedAt = Date.now();
    const session: ActiveSession = {
      meetingId,
      conversationId,
      containerId: runResult.containerId,
      botBaseUrl,
      botApiToken,
      startedAt,
      joinTimeoutMs,
      timeoutHandle: null,
      audioIngest,
      eventUnsubscribes: [],
      joinedPublished: false,
      consentMonitor,
      conversationBridge,
      storageWriter,
      chatOpportunityDetector,
      ttsBridge,
      ttsLipsyncHandle,
      bargeInWatcher,
      leaveInitiatedByDaemon: false,
    };
    this.sessions.set(meetingId, session);
    // `this.sessions` is now the authoritative source for the resolver;
    // the pre-registered pending entry is no longer needed.
    this.pendingBotTokens.delete(meetingId);

    // Fan `participant.change` / `speaker.change` / final transcript chunks
    // out as `meet.*` events on the assistant event hub.
    session.eventUnsubscribes.push(subscribeEventHubPublisher(meetingId));

    // Watch for the bot's first `lifecycle: joined` so we can emit a
    // client-facing `meet.joined` at the precise moment the bot is live
    // in the meeting. Lifecycle publish happens once per session.
    session.eventUnsubscribes.push(
      subscribeToMeetingEvents(meetingId, (event) => {
        if (event.type !== "lifecycle") return;
        if (event.state === "joined" && !session.joinedPublished) {
          session.joinedPublished = true;
          void publishMeetEvent(meetingId, "meet.joined", {});
          return;
        }
        if (event.state === "error") {
          void publishMeetEvent(meetingId, "meet.error", {
            detail: event.detail ?? "unknown error",
          });
        }
      }),
    );

    // Subscribe the conversation bridge + start the storage writer now
    // that the session record is in place. If either throws, roll back the
    // container and audio ingest so we don't leak a running bot.
    try {
      conversationBridge.subscribe();
      storageWriter.start();
    } catch (err) {
      this.log.error(
        "Bridge/writer subscribe failed — rolling back container and audio ingest",
        { err, meetingId, containerId: runResult.containerId },
      );
      this.sessions.delete(meetingId);
      for (const unsubscribe of session.eventUnsubscribes) {
        try {
          unsubscribe();
        } catch {}
      }
      // Unsubscribe the lip-sync forwarder before we move on so no viseme
      // event fires against the soon-to-be-removed bridge / container.
      try {
        ttsLipsyncHandle.stop();
      } catch {
        /* best-effort */
      }
      unregisterMeetingDispatcher(meetingId);
      await audioIngest.stop().catch(() => {});
      await runner.stop(runResult.containerId).catch(() => {});
      await captureBotLogs(runner, runResult.containerId, meetingDir, this.log);
      await runner.remove(runResult.containerId).catch(() => {});
      void publishMeetEvent(meetingId, "meet.error", {
        detail: errorDetail(err),
      });
      throw err;
    }
    const pcmSource: PcmSource = {
      subscribe: (cb) => audioIngest.subscribePcm(cb),
    };
    try {
      await storageWriter.startAudio(pcmSource);
    } catch (err) {
      // A failure to spawn ffmpeg is non-fatal: the rest of the session
      // (transcripts, chat, participant events) remains functional. Log
      // and continue so a missing ffmpeg binary doesn't fail the join.
      this.log.warn(
        "MeetStorageWriter.startAudio failed — continuing without audio capture",
        { err, meetingId },
      );
    }

    // Now that the other subscribers and the session record are in place,
    // start the consent monitor so it has a live dispatcher to attach to.
    consentMonitor.start();

    // Chat-opportunity detector subscribes to the same dispatcher. Skipped
    // entirely when `proactiveChat.enabled === false` (detector is null).
    chatOpportunityDetector?.start();

    // Barge-in watcher subscribes to the dispatcher (for speaker.change /
    // transcript.chunk / participant.change) and the assistant-event-hub
    // (for `meet.speaking_*` lifecycle). Auto-cancels in-flight TTS when
    // a non-bot speaker takes the floor.
    bargeInWatcher.start();

    // Max-meeting-minutes hard cap. Using setTimeout keeps this compatible
    // with Bun's fake-timer harness for tests.
    session.timeoutHandle = setTimeout(() => {
      void this.leave(meetingId, "timeout").catch((err) => {
        this.log.error("Error during max-meeting-minutes timeout cleanup", {
          err,
          meetingId,
        });
      });
    }, joinTimeoutMs);

    // Container-exit watcher. Docker's `POST /containers/<id>/wait` holds a
    // long-lived HTTP connection open until the container terminates and
    // then replies with the exit code — a far cheaper signal than polling
    // `docker inspect`. We fire-and-forget the wait: on the happy path the
    // daemon's own `leave()` sets `leaveInitiatedByDaemon = true` before
    // the container-remove fires, so when `wait` resolves (either with
    // the container's real exit code or with `StatusCode: 0` via the 404
    // branch in `DockerRunner.wait` when `remove()` ran first) the
    // watcher sees the flag and becomes a no-op.
    //
    // The failure path this closes: some external process — a user
    // `docker kill`, a concurrent stray daemon's reaper sweep, an OOM
    // killer, a node-level pod eviction — terminates the bot container
    // without going through our `leave()`. Without this watcher, the
    // daemon's `this.sessions` keeps the meeting pinned as "joined"
    // forever; subsequent `meet_speak`/`meet_send_chat` tool calls fail
    // against a dead bot; the Swift client stays stuck in the "joined"
    // state with no way to recover. Synthesizing a `meet.error` + tearing
    // session state here lets the client observe the bot's death and the
    // daemon reclaim the slot.
    void runner
      .wait(runResult.containerId)
      .then(async (waitResult) => {
        await this.handleContainerExit(
          meetingId,
          runResult.containerId,
          waitResult,
        );
      })
      .catch((err) => {
        this.log.warn(
          "Container-exit watcher errored — cannot observe bot container exit",
          { err, meetingId, containerId: runResult.containerId },
        );
      });

    this.log.info("Meet session joined", {
      meetingId,
      conversationId,
      containerId: runResult.containerId,
      botBaseUrl,
      joinTimeoutMs,
    });

    return sessionView(session);
  }

  /**
   * Tear down a meeting: try the bot's `/leave` first, fall back to
   * `stop` + `remove`. Idempotent — calling leave on an unknown meeting
   * is a no-op.
   */
  async leave(meetingId: string, reason: string): Promise<void> {
    const session = this.sessions.get(meetingId);
    if (!session) {
      this.log.debug("leave(): no active session — no-op", {
        meetingId,
        reason,
      });
      return;
    }

    // Flag the container-exit watcher BEFORE any awaits. The watcher's
    // `runner.wait(...)` promise resolves the instant `runner.remove()`
    // below fires (the engine's 404 branch in `DockerRunner.wait`
    // converts the "gone" response to `StatusCode: 0`), so without this
    // flag set first a slow teardown path could still race the engine
    // and have the watcher fire a duplicate `meet.error` before the
    // synthetic `lifecycle:left` lands. Single synchronous assignment —
    // no throw path to guard.
    session.leaveInitiatedByDaemon = true;

    // Stop the consent monitor first — any pending LLM call can finish
    // harmlessly since `decided` is the only write path it has to the
    // session manager, and we've already committed to leaving. This also
    // clears the 20s tick timer so it can't fire during teardown.
    try {
      session.consentMonitor.stop();
    } catch (err) {
      this.log.warn(
        "MeetConsentMonitor.stop threw during leave — continuing teardown",
        { err, meetingId },
      );
    }

    // Dispose the chat-opportunity detector alongside the consent monitor
    // so no late transcript/chat event fires an agent wake during
    // teardown. Safe when the detector is null (proactive chat disabled).
    try {
      session.chatOpportunityDetector?.dispose();
    } catch (err) {
      this.log.warn(
        "MeetChatOpportunityDetector.dispose threw during leave — continuing teardown",
        { err, meetingId },
      );
    }

    // Stop the barge-in watcher before we cancel any in-flight TTS so the
    // synthetic `meet.speaking_ended` events emitted by `cancelAll` below
    // don't trigger any dispatcher work in the watcher. Also clears any
    // pending debounced cancel that hasn't fired yet.
    try {
      session.bargeInWatcher.stop();
    } catch (err) {
      this.log.warn(
        "MeetBargeInWatcher.stop threw during leave — continuing teardown",
        { err, meetingId },
      );
    }

    // Stop the TTS lip-sync forwarder BEFORE we cancel in-flight TTS so no
    // late viseme POST fires against a shutting-down bridge. The forwarder's
    // `stop()` only unsubscribes from the bridge's `onViseme` channel — it
    // does not wait for any in-flight `/avatar/viseme` POSTs to settle, since
    // those are fire-and-forget and tolerate being dropped.
    try {
      session.ttsLipsyncHandle.stop();
    } catch (err) {
      this.log.warn(
        "TtsLipsyncHandle.stop threw during leave — continuing teardown",
        { err, meetingId },
      );
    }

    // Cancel any in-flight TTS streams so orphan playback doesn't try to
    // talk to a bot container that's about to be removed. `cancelAll`
    // awaits the per-stream teardown (which includes the best-effort
    // DELETE /play_audio/<id>) — bounded by the stream's own abort path.
    try {
      await session.ttsBridge.cancelAll();
    } catch (err) {
      this.log.warn(
        "MeetTtsBridge.cancelAll threw during leave — continuing teardown",
        { err, meetingId },
      );
    }

    // Immediately clear state so we don't re-enter this path via the timeout
    // firing concurrently with a caller-initiated leave.
    if (session.timeoutHandle) {
      clearTimeout(session.timeoutHandle);
      session.timeoutHandle = null;
    }
    this.sessions.delete(meetingId);

    // Synthesize a `lifecycle:left` event BEFORE tearing the dispatcher
    // down so the storage writer's `meta.json` flush runs while its
    // subscription is still live. The bot's own terminal `lifecycle:left`
    // event races against `/leave` and may arrive after we've already
    // unregistered the dispatcher, which would leave `meta.json`
    // unwritten. Dispatching here (then tearing down below) guarantees at
    // least one delivery.
    try {
      meetEventDispatcher.dispatch(meetingId, {
        type: "lifecycle",
        meetingId,
        timestamp: new Date().toISOString(),
        state: "left",
        detail: reason,
      });
    } catch (err) {
      this.log.warn(
        "Meet synthesized lifecycle:left dispatch threw during leave",
        { err, meetingId },
      );
    }

    // Stop the conversation bridge + storage writer before dropping the
    // dispatcher so their own teardown paths see a live dispatcher (for
    // the bridge, this just removes its subscription; for the writer, its
    // internal unsubscribe runs synchronously so ordering doesn't matter
    // beyond the synthesized `lifecycle:left` above).
    try {
      session.conversationBridge.unsubscribe();
    } catch (err) {
      this.log.warn("MeetConversationBridge.unsubscribe threw during leave", {
        err,
        meetingId,
      });
    }
    try {
      await session.storageWriter.stop();
    } catch (err) {
      this.log.warn("MeetStorageWriter.stop threw during leave", {
        err,
        meetingId,
      });
    }

    // Tear down dispatcher subscribers BEFORE unregistering the router so no
    // in-flight event slips through to a subscriber whose consumer is gone.
    for (const unsubscribe of session.eventUnsubscribes) {
      try {
        unsubscribe();
      } catch (err) {
        this.log.warn("Meet event subscriber unsubscribe threw during leave", {
          err,
          meetingId,
        });
      }
    }
    session.eventUnsubscribes = [];
    unregisterMeetingDispatcher(meetingId);

    const runner = this.deps.dockerRunnerFactory();

    let gracefulOk = false;
    try {
      await this.deps.botLeaveFetch(
        `${session.botBaseUrl}/leave`,
        session.botApiToken,
      );
      gracefulOk = true;
    } catch (err) {
      this.log.warn(
        "Bot /leave failed or timed out — falling back to container stop",
        { err, meetingId, reason },
      );
    }

    if (!gracefulOk) {
      try {
        await runner.stop(session.containerId);
      } catch (err) {
        this.log.warn("DockerRunner.stop failed — proceeding to remove", {
          err,
          meetingId,
          containerId: session.containerId,
        });
      }
    }

    try {
      await runner.remove(session.containerId);
    } catch (err) {
      this.log.warn("DockerRunner.remove failed — container may leak", {
        err,
        meetingId,
        containerId: session.containerId,
      });
    }

    // Tear down the audio-ingest after the container is gone — stopping it
    // earlier would force the bot's outbound audio writes to fail while
    // the container is still shutting down.
    try {
      await session.audioIngest.stop();
    } catch (err) {
      this.log.warn(
        "MeetAudioIngest.stop failed — socket or streaming STT session may leak",
        { err, meetingId },
      );
    }

    // Per-meeting proactive-chat summary. Emitted unconditionally on
    // leave when a detector was constructed, even if `enabled` was later
    // flipped off at config-watcher time — the stats snapshot is cheap
    // and the log line is useful telemetry for tuning the Tier 1 + Tier 2
    // gating. When the detector was never constructed the field is
    // absent.
    const chatStats: ChatOpportunityDetectorStats | undefined =
      session.chatOpportunityDetector?.getStats();

    void publishMeetEvent(meetingId, "meet.left", { reason });

    this.log.info("Meet session left", {
      meetingId,
      containerId: session.containerId,
      reason,
      gracefulOk,
      chatOpportunityStats: chatStats,
    });
  }

  /**
   * Handle an unexpected bot container exit observed by the per-session
   * container-exit watcher wired up in `join()`. Fires when
   * `docker.wait(containerId)` resolves — which the Docker Engine does the
   * moment the container terminates, regardless of cause.
   *
   * No-op in two cases:
   *   1. The daemon's own `leave()` already set `leaveInitiatedByDaemon =
   *      true` — the watcher is observing the graceful teardown's own
   *      `runner.remove()`, and `leave()` is still mid-flight handling all
   *      the cleanup. Firing here would duplicate the `meet.error` publish
   *      and race the rest of the teardown.
   *   2. The session is no longer in `this.sessions`. This can happen if
   *      `leave()` already completed (ran to the `this.sessions.delete()`
   *      line) before `wait` resolved, or if a rollback path dropped the
   *      session without ever recording `leaveInitiatedByDaemon` because
   *      the rollback fires before the watcher is installed. Either way
   *      there's nothing left to tear down.
   *
   * On the real external-exit path we mirror `leave()`'s cleanup with two
   * deliberate omissions:
   *   - Skip `botLeaveFetch` — the bot container is already dead, so an
   *     HTTP call would just hit `ECONNREFUSED` and burn 10s on the
   *     timeout before we could even start the actual teardown.
   *   - Skip `runner.stop` — likewise, stopping an already-exited container
   *     surfaces a 304 or a cryptic engine error. We go straight to
   *     `runner.remove()` (best-effort) to unregister the corpse so it
   *     doesn't linger in `docker ps -a`.
   *
   * Publishes a `meet.error` with a human-readable `detail` identifying
   * the unexpected exit so connected clients can render a useful error
   * state instead of staying pinned in "joined" forever.
   */
  private async handleContainerExit(
    meetingId: string,
    containerId: string,
    waitResult: DockerWaitResult,
  ): Promise<void> {
    const session = this.sessions.get(meetingId);
    if (!session) return;
    if (session.leaveInitiatedByDaemon) return;
    // Defensive: if this watcher fires for a session whose `containerId`
    // no longer matches (a subsequent join would replace the map entry —
    // though the same-meeting-id guard in join() should make that
    // impossible), treat it like the session-missing branch above.
    if (session.containerId !== containerId) return;

    const exitCode = waitResult.StatusCode;
    const engineError = waitResult.Error?.Message ?? null;
    const detail = engineError
      ? `bot container exited unexpectedly (exitCode=${exitCode}, error=${engineError})`
      : `bot container exited unexpectedly (exitCode=${exitCode})`;

    this.log.info(
      "Meet bot container exited unexpectedly — tearing session down",
      { meetingId, containerId, exitCode, engineError },
    );

    void publishMeetEvent(meetingId, "meet.error", { detail });

    // Claim the session before any awaits so a concurrent `leave()` call
    // (e.g. from a tool handler reacting to the `meet.error` we just
    // published) takes the no-op branch rather than double-tearing.
    session.leaveInitiatedByDaemon = true;

    // Symmetric teardown with `leave()` — same order, minus bot HTTP + stop.
    try {
      session.consentMonitor.stop();
    } catch (err) {
      this.log.warn(
        "MeetConsentMonitor.stop threw during container-exit teardown",
        { err, meetingId },
      );
    }
    try {
      session.chatOpportunityDetector?.dispose();
    } catch (err) {
      this.log.warn(
        "MeetChatOpportunityDetector.dispose threw during container-exit teardown",
        { err, meetingId },
      );
    }
    try {
      session.bargeInWatcher.stop();
    } catch (err) {
      this.log.warn(
        "MeetBargeInWatcher.stop threw during container-exit teardown",
        { err, meetingId },
      );
    }
    try {
      session.ttsLipsyncHandle.stop();
    } catch (err) {
      this.log.warn(
        "TtsLipsyncHandle.stop threw during container-exit teardown",
        { err, meetingId },
      );
    }
    try {
      await session.ttsBridge.cancelAll();
    } catch (err) {
      this.log.warn(
        "MeetTtsBridge.cancelAll threw during container-exit teardown",
        { err, meetingId },
      );
    }

    if (session.timeoutHandle) {
      clearTimeout(session.timeoutHandle);
      session.timeoutHandle = null;
    }
    this.sessions.delete(meetingId);
    this.pendingBotTokens.delete(meetingId);

    // Synthesize a `lifecycle:left` event BEFORE tearing the dispatcher
    // down so the storage writer's `meta.json` flush runs while its
    // subscription is still live. Without this, an unexpected container
    // exit skips the only code path that writes final meeting metadata
    // (MeetStorageWriter only flushes on `lifecycle:left`). Mirrors the
    // dispatch in `leave()`.
    try {
      meetEventDispatcher.dispatch(meetingId, {
        type: "lifecycle",
        meetingId,
        timestamp: new Date().toISOString(),
        state: "left",
        detail: "container-exit",
      });
    } catch (err) {
      this.log.warn(
        "Meet synthesized lifecycle:left dispatch threw during container-exit teardown",
        { err, meetingId },
      );
    }

    try {
      session.conversationBridge.unsubscribe();
    } catch (err) {
      this.log.warn(
        "MeetConversationBridge.unsubscribe threw during container-exit teardown",
        { err, meetingId },
      );
    }
    try {
      await session.storageWriter.stop();
    } catch (err) {
      this.log.warn(
        "MeetStorageWriter.stop threw during container-exit teardown",
        { err, meetingId },
      );
    }

    for (const unsubscribe of session.eventUnsubscribes) {
      try {
        unsubscribe();
      } catch (err) {
        this.log.warn(
          "Meet event subscriber unsubscribe threw during container-exit teardown",
          { err, meetingId },
        );
      }
    }
    session.eventUnsubscribes = [];
    unregisterMeetingDispatcher(meetingId);

    // Container is already dead — skip `runner.stop`, but still best-effort
    // `runner.remove()` so the exited container doesn't linger in
    // `docker ps -a` forever.
    const runner = this.deps.dockerRunnerFactory();
    try {
      await runner.remove(containerId);
    } catch (err) {
      this.log.warn(
        "DockerRunner.remove failed during container-exit teardown — container may linger in `docker ps -a`",
        { err, meetingId, containerId },
      );
    }

    try {
      await session.audioIngest.stop();
    } catch (err) {
      this.log.warn(
        "MeetAudioIngest.stop failed during container-exit teardown — socket or streaming STT session may leak",
        { err, meetingId },
      );
    }
  }

  /** Snapshot of currently-active sessions (excludes internal fields). */
  activeSessions(): MeetSession[] {
    return Array.from(this.sessions.values()).map(sessionView);
  }

  /** Look up a session by meeting id, or `null` when none is active. */
  getSession(meetingId: string): MeetSession | null {
    const session = this.sessions.get(meetingId);
    return session ? sessionView(session) : null;
  }

  /**
   * Post a chat message into the meeting via the bot's `/send_chat`
   * endpoint. Looks up the per-meeting bearer token so the bot can
   * authenticate the inbound request, forwards the text as
   * `{ type: "send_chat", text }`, and emits a `meet.chat_sent` event on
   * success.
   *
   * Throws:
   *   - {@link MeetSessionNotFoundError} when no active session exists for
   *     the id.
   *   - {@link MeetSessionUnreachableError} on network-level failures
   *     (connection refused, DNS, timeout) — the bot container is likely
   *     gone.
   *   - {@link MeetBotChatError} when the bot responded with a non-2xx
   *     status (e.g. 502 when the upstream Meet chat call failed).
   */
  async sendChat(meetingId: string, text: string): Promise<void> {
    const session = this.sessions.get(meetingId);
    if (!session) {
      throw new MeetSessionNotFoundError(meetingId);
    }

    await this.deps.botSendChatFetch(
      `${session.botBaseUrl}/send_chat`,
      session.botApiToken,
      text,
      meetingId,
    );

    void publishMeetEvent(meetingId, "meet.chat_sent", { text });

    this.log.info("Meet chat message sent", {
      meetingId,
      textLength: text.length,
    });
  }

  /**
   * Speak synthesized audio into the meeting via the bot's `/play_audio`
   * endpoint. Thin wrapper over {@link MeetTtsBridge.speak} that looks up
   * the active session, publishes `meet.speaking_started` before the stream
   * begins, and publishes `meet.speaking_ended` once the bot-side playback
   * settles. Returns the opaque streamId so callers can cancel the stream
   * mid-playback via {@link cancelSpeak}.
   *
   * Throws {@link MeetSessionNotFoundError} when no active session exists.
   */
  async speak(
    meetingId: string,
    input: { text: string; voice?: string; streamId?: string },
  ): Promise<{ streamId: string }> {
    const session = this.sessions.get(meetingId);
    if (!session) {
      throw new MeetSessionNotFoundError(meetingId);
    }

    const result = await session.ttsBridge.speak(input);
    const streamId = result.streamId;

    void publishMeetEvent(meetingId, "meet.speaking_started", { streamId });

    // Fire-and-forget completion publisher. `result.completion` resolves
    // when the outbound POST settles (either success, cancel, or error);
    // errors are rethrown from the bridge so we can distinguish a natural
    // finish from a rejected one and emit the matching reason.
    void result.completion
      .then(() => {
        void publishMeetEvent(meetingId, "meet.speaking_ended", {
          streamId,
          reason: "completed" as const,
        });
      })
      .catch((err) => {
        const isCancel =
          err instanceof MeetTtsCancelledError ||
          (err !== null &&
            typeof err === "object" &&
            (err as { code?: unknown }).code === "MEET_TTS_CANCELLED");
        const reason: "cancelled" | "error" = isCancel ? "cancelled" : "error";
        // Cancels are expected during barge-in / caller cancel / leave —
        // log at debug so they don't spam warn logs; genuine errors stay
        // at warn.
        if (isCancel) {
          this.log.debug("MeetTtsBridge speak cancelled", {
            meetingId,
            streamId,
            reason,
          });
        } else {
          this.log.warn("MeetTtsBridge speak completion rejected", {
            err,
            meetingId,
            streamId,
            reason,
          });
        }
        void publishMeetEvent(meetingId, "meet.speaking_ended", {
          streamId,
          reason,
        });
      });

    this.log.info("Meet TTS speak started", {
      meetingId,
      streamId,
      textLength: input.text.length,
    });

    return { streamId };
  }

  /**
   * Cancel every in-flight TTS stream for the meeting. Idempotent — safe
   * to call when no streams are active. Throws
   * {@link MeetSessionNotFoundError} when no active session exists so
   * callers can distinguish "unknown meeting" from "nothing to cancel".
   */
  async cancelSpeak(meetingId: string): Promise<void> {
    const session = this.sessions.get(meetingId);
    if (!session) {
      throw new MeetSessionNotFoundError(meetingId);
    }
    await session.ttsBridge.cancelAll();
  }

  /**
   * Turn on the bot's video avatar via the bot's `/avatar/enable` endpoint.
   * The bot starts its configured renderer, attaches it to the v4l2loopback
   * device that backs the Meet camera, and flips the Meet camera toggle ON
   * so other participants start receiving frames. Idempotent on the bot
   * side: calling again while the avatar is already running returns
   * `{alreadyRunning: true}` without re-initializing the renderer.
   *
   * Returns the parsed JSON body from the bot so tool-layer callers can
   * relay useful fields (`renderer`, `alreadyRunning`, `cameraChanged`,
   * etc.) back to the model.
   *
   * Throws:
   *   - {@link MeetSessionNotFoundError} when no active session exists.
   *   - {@link MeetSessionUnreachableError} on network-level failure.
   *   - {@link MeetBotAvatarError} when the bot responded with a non-2xx
   *     status (e.g. 503 when the avatar subsystem is disabled or the
   *     renderer is unavailable on this host).
   */
  async enableAvatar(meetingId: string): Promise<Record<string, unknown>> {
    const session = this.sessions.get(meetingId);
    if (!session) {
      throw new MeetSessionNotFoundError(meetingId);
    }

    const body = await this.deps.botAvatarFetch(
      `${session.botBaseUrl}/avatar/enable`,
      session.botApiToken,
      "/avatar/enable",
      meetingId,
    );

    this.log.info("Meet avatar enabled", { meetingId, body });
    return body;
  }

  /**
   * Turn off the bot's video avatar via the bot's `/avatar/disable`
   * endpoint. The bot flips the Meet camera toggle OFF and tears down the
   * renderer + device writer. Idempotent on the bot side: calling while
   * already off returns `{wasActive: false}` without error.
   *
   * Returns the parsed JSON body so tool-layer callers can relay
   * `wasActive`, `cameraChanged`, etc. back to the model.
   *
   * Throws:
   *   - {@link MeetSessionNotFoundError} when no active session exists.
   *   - {@link MeetSessionUnreachableError} on network-level failure.
   *   - {@link MeetBotAvatarError} when the bot responded with a non-2xx
   *     status.
   */
  async disableAvatar(meetingId: string): Promise<Record<string, unknown>> {
    const session = this.sessions.get(meetingId);
    if (!session) {
      throw new MeetSessionNotFoundError(meetingId);
    }

    const body = await this.deps.botAvatarFetch(
      `${session.botBaseUrl}/avatar/disable`,
      session.botApiToken,
      "/avatar/disable",
      meetingId,
    );

    this.log.info("Meet avatar disabled", { meetingId, body });
    return body;
  }

  /**
   * Tear down every active meeting in parallel with a shared overall deadline.
   *
   * Invoked from the daemon's shutdown sequence so live meetings don't leak
   * containers or audio ingests when the host process exits. The leave path
   * already handles its own graceful-then-force routine (`bot /leave` →
   * `runner.stop` → `runner.remove`), so this method just races the set of
   * `leave(id, reason)` calls against the shared deadline.
   *
   * When the deadline expires, any session whose `leave()` hasn't yet
   * resolved is force-stopped via {@link DockerRunner.stop} + `remove` so
   * the container doesn't outlive the daemon. Audio ingests for those
   * sessions are stopped best-effort too. Because `leave()` delete-s the
   * session from the map early (to guard against re-entry), we snapshot the
   * container id / audio ingest *before* launching each leave and drive the
   * straggler cleanup from that snapshot.
   *
   * Idempotent — calling with no active sessions is a no-op that resolves
   * immediately.
   *
   * @param reason Free-form reason forwarded to `leave(id, reason)` — e.g.
   *               `"daemon-shutdown"`. Recorded in `meet.left` events and
   *               the log stream.
   * @param totalDeadlineMs Hard upper bound (ms) for the entire shutdown.
   *                        Default `15_000` matches the daemon-level
   *                        graceful-shutdown budget.
   */
  async shutdownAll(
    reason: string,
    totalDeadlineMs = MEET_SHUTDOWN_DEADLINE_MS,
  ): Promise<void> {
    this.shuttingDown = true;
    // Snapshot what we need for the straggler path BEFORE launching the
    // leaves, since `leave()` drops sessions from the map early.
    const snapshot = Array.from(this.sessions.values()).map((session) => ({
      meetingId: session.meetingId,
      containerId: session.containerId,
      audioIngest: session.audioIngest,
    }));
    if (snapshot.length === 0) return;

    this.log.info("MeetSessionManager: shutting down active sessions", {
      count: snapshot.length,
      reason,
      totalDeadlineMs,
    });

    // Fire all leaves in parallel. Track which have resolved so we can
    // identify stragglers after the deadline expires. `leave()` catches
    // its own teardown errors, but we guard again here in case a refactor
    // changes that.
    const resolved = new Set<string>();
    const leaves = snapshot.map((entry) =>
      this.leave(entry.meetingId, reason)
        .catch((err) => {
          this.log.warn(
            "MeetSessionManager.shutdownAll: leave() rejected — continuing",
            { err, meetingId: entry.meetingId, reason },
          );
        })
        .finally(() => {
          resolved.add(entry.meetingId);
        }),
    );
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<"timeout">((resolve) => {
      deadlineTimer = setTimeout(() => resolve("timeout"), totalDeadlineMs);
    });
    const outcome = await Promise.race([
      Promise.all(leaves).then(() => "completed" as const),
      deadline,
    ]);
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);

    if (outcome === "timeout") {
      const stragglers = snapshot.filter((s) => !resolved.has(s.meetingId));
      this.log.warn(
        "MeetSessionManager.shutdownAll: deadline exceeded — force-stopping containers",
        {
          count: stragglers.length,
          reason,
          totalDeadlineMs,
        },
      );
      const runner = this.deps.dockerRunnerFactory();
      const forced = stragglers.map(async (entry) => {
        // The active session may or may not still be in the map — `leave()`
        // might have progressed past the early `sessions.delete` but be
        // stuck on the bot HTTP or docker remove. Either way, drive the
        // force path directly from the snapshot and unwind any lingering
        // in-process state if the session record is still around.
        const lingering = this.sessions.get(entry.meetingId);
        if (lingering) {
          try {
            lingering.consentMonitor.stop();
          } catch {
            /* best-effort */
          }
          try {
            lingering.chatOpportunityDetector?.dispose();
          } catch {
            /* best-effort */
          }
          try {
            lingering.bargeInWatcher.stop();
          } catch {
            /* best-effort */
          }
          try {
            lingering.ttsLipsyncHandle.stop();
          } catch {
            /* best-effort */
          }
          try {
            await lingering.ttsBridge.cancelAll();
          } catch {
            /* best-effort */
          }
          try {
            lingering.conversationBridge.unsubscribe();
          } catch {
            /* best-effort */
          }
          try {
            await lingering.storageWriter.stop();
          } catch {
            /* best-effort */
          }
          if (lingering.timeoutHandle) {
            clearTimeout(lingering.timeoutHandle);
            lingering.timeoutHandle = null;
          }
          for (const unsubscribe of lingering.eventUnsubscribes) {
            try {
              unsubscribe();
            } catch {
              /* best-effort */
            }
          }
          lingering.eventUnsubscribes = [];
          unregisterMeetingDispatcher(entry.meetingId);
          this.sessions.delete(entry.meetingId);
        }

        try {
          await runner.stop(entry.containerId);
        } catch (err) {
          this.log.warn("MeetSessionManager.shutdownAll: runner.stop threw", {
            err,
            meetingId: entry.meetingId,
            containerId: entry.containerId,
          });
        }
        try {
          await runner.remove(entry.containerId);
        } catch (err) {
          this.log.warn("MeetSessionManager.shutdownAll: runner.remove threw", {
            err,
            meetingId: entry.meetingId,
            containerId: entry.containerId,
          });
        }
        try {
          await entry.audioIngest.stop();
        } catch (err) {
          this.log.warn(
            "MeetSessionManager.shutdownAll: audioIngest.stop threw",
            { err, meetingId: entry.meetingId },
          );
        }
      });
      await Promise.allSettled(forced);
    }

    this.log.info("MeetSessionManager: active-session shutdown complete", {
      outcome,
      reason,
    });
  }

  /**
   * Tier 2 chat-opportunity LLM callback. Routes through the host's
   * provider facet under the `meetChatOpportunity` call site, keeping
   * the proactive-chat path on its own configurable lane alongside the
   * consent monitor. Times out at {@link CHAT_OPPORTUNITY_LLM_TIMEOUT_MS}
   * and extracts the tool-use input as the structured verdict.
   *
   * On missing provider or malformed output we fall back to a
   * conservative `shouldRespond: false` verdict — never interrupt a
   * meeting because of missing infrastructure.
   */
  private async callDetectorLLM(
    prompt: string,
  ): Promise<ChatOpportunityDecision> {
    const llm = this.host.providers.llm;
    const provider = (await llm.getConfigured(
      "meetChatOpportunity",
    )) as LlmProviderLike | null;
    if (!provider) {
      return { shouldRespond: false, reason: "" };
    }

    const { signal, cleanup } = llm.createTimeout(
      CHAT_OPPORTUNITY_LLM_TIMEOUT_MS,
    );
    try {
      const response = await provider.sendMessage(
        [llm.userMessage(prompt)],
        [CHAT_OPPORTUNITY_TOOL],
        "You are a strict JSON classifier. Only respond via the report_chat_opportunity tool.",
        {
          config: {
            callSite: "meetChatOpportunity",
            max_tokens: CHAT_OPPORTUNITY_LLM_MAX_TOKENS,
            tool_choice: {
              type: "tool" as const,
              name: CHAT_OPPORTUNITY_TOOL.name,
            },
          },
          signal,
        },
      );
      const tool = llm.extractToolUse(response) as {
        input?: { shouldRespond?: unknown; reason?: unknown };
      } | null;
      if (!tool) return { shouldRespond: false, reason: "" };
      const input = tool.input ?? {};
      return {
        shouldRespond: input.shouldRespond === true,
        reason: typeof input.reason === "string" ? input.reason : "",
      };
    } finally {
      cleanup();
    }
  }
}

// ---------------------------------------------------------------------------
// Factory + singleton export
// ---------------------------------------------------------------------------

/**
 * Installed session-manager instance — populated by
 * {@link createMeetSessionManager} (called from `register(host)`) and
 * read by {@link MeetSessionManager} below.
 *
 * The tool modules currently import the singleton directly so they can
 * call `MeetSessionManager.join(...)` without threading the session
 * manager through every call site. Until that pattern is replaced with
 * an explicit dependency injection path (out of scope here), the
 * installed instance stands in via a Proxy that delegates to whichever
 * manager the skill's `register(host)` entry point created.
 */
let installedSessionManager: MeetSessionManagerImpl | null = null;

/**
 * Build a session manager bound to the supplied {@link SkillHost} and
 * install it as the module-level singleton. Called once by
 * `register(host)`; tests that want a throwaway instance use
 * {@link _createMeetSessionManagerForTests} instead.
 */
export function createMeetSessionManager(
  host: SkillHost,
  deps: MeetSessionManagerDeps = {},
): MeetSessionManagerImpl {
  const manager = new MeetSessionManagerImpl(host, deps);
  installedSessionManager = manager;
  return manager;
}

function requireInstalledSessionManager(): MeetSessionManagerImpl {
  if (!installedSessionManager) {
    throw new Error(
      "MeetSessionManager accessed before createMeetSessionManager(host) installed an instance. " +
        "Ensure register(host) ran during skill bootstrap.",
    );
  }
  return installedSessionManager;
}

/**
 * Process-wide session manager singleton. The proxy lazily resolves to
 * whichever instance `register(host)` installed. Tools that historically
 * did `MeetSessionManager.join(...)` keep working unchanged.
 */
export const MeetSessionManager: MeetSessionManagerImpl = new Proxy(
  {} as MeetSessionManagerImpl,
  {
    get(_target, prop, receiver) {
      const manager = requireInstalledSessionManager();
      const value = Reflect.get(
        manager as unknown as Record<PropertyKey, unknown>,
        prop,
        receiver,
      );
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(manager)
        : value;
    },
  },
);

/** Test helper: drop the installed singleton so the next test case starts clean. */
export function _resetMeetSessionManagerForTests(): void {
  installedSessionManager = null;
}

/** Exposed for integration tests that need a clean instance. */
export function _createMeetSessionManagerForTests(
  hostOrDeps?: SkillHost | MeetSessionManagerDeps,
  deps?: MeetSessionManagerDeps,
): MeetSessionManagerImpl {
  // Two-signature overload to preserve compatibility with the legacy
  // `_createMeetSessionManagerForTests(deps)` callsite pattern. When the
  // first argument looks like a `SkillHost` (has the `logger` facet),
  // treat it as the host; otherwise treat it as `deps` and build a
  // minimal stand-in host. Most session-manager tests inject every code
  // path they exercise via `deps.*` overrides, so the defaults on the
  // stand-in host are rarely consulted.
  let host: SkillHost;
  let resolvedDeps: MeetSessionManagerDeps | undefined;
  if (hostOrDeps && "logger" in hostOrDeps && "registries" in hostOrDeps) {
    host = hostOrDeps;
    resolvedDeps = deps;
  } else {
    host = buildSessionManagerTestHost();
    resolvedDeps = hostOrDeps;
  }

  // Default to disabling the startup orphan-reaper sweep in tests — most
  // tests supply a narrow mock runner that only implements the
  // `run`/`stop`/`remove`/`inspect`/`logs` surface used by the
  // join/leave path. Tests that want to exercise the reaper can override
  // by passing `disableStartupOrphanReaper: false`.
  return new MeetSessionManagerImpl(host, {
    disableStartupOrphanReaper: true,
    ...resolvedDeps,
  });
}

/**
 * Minimal in-file `SkillHost` stand-in used when legacy session-manager
 * tests call `_createMeetSessionManagerForTests(deps)` without an
 * explicit host. Every facet is a no-op that throws on accidental
 * access; session-manager tests drive behavior through `deps.*`
 * overrides, so the host is rarely consulted on the hot path.
 */
function buildSessionManagerTestHost(): SkillHost {
  const noopLogger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const unsupported = (facet: string) => () => {
    throw new Error(
      `session-manager test stand-in host: ${facet} is not supported in legacy no-host test calls. ` +
        "Pass an explicit SkillHost as the first argument to _createMeetSessionManagerForTests().",
    );
  };
  return {
    logger: { get: () => noopLogger },
    config: {
      isFeatureFlagEnabled: () => false,
      getSection: () => undefined,
    },
    identity: {
      getAssistantName: () => undefined,
    },
    platform: {
      workspaceDir: () => "/tmp/session-manager-test-workspace",
      vellumRoot: () => "/tmp/session-manager-test-vellum",
      runtimeMode: () => "bare-metal" as DaemonRuntimeMode,
    },
    providers: {
      llm: {
        getConfigured: unsupported("providers.llm.getConfigured"),
        userMessage: unsupported("providers.llm.userMessage"),
        extractToolUse: () => null,
        createTimeout: (ms: number) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), ms);
          return {
            signal: controller.signal,
            cleanup: () => clearTimeout(timer),
          };
        },
      },
      stt: {
        listProviderIds: () => [],
        supportsBoundary: () => false,
        resolveStreamingTranscriber: unsupported(
          "providers.stt.resolveStreamingTranscriber",
        ),
      },
      tts: {
        get: unsupported("providers.tts.get"),
        resolveConfig: () => ({}),
      },
      secureKeys: { getProviderKey: async () => null },
    },
    memory: {
      addMessage: (async () => ({ id: "msg-test" })) as InsertMessageFn,
      wakeAgentForOpportunity: async () => {},
    },
    events: {
      publish: async () => {},
      subscribe: () => ({ dispose: () => {}, active: true }),
      buildEvent: unsupported("events.buildEvent"),
    },
    registries: {
      registerTools: () => {},
      registerSkillRoute: () => ({}) as never,
      registerShutdownHook: () => {},
    },
    speakers: { createTracker: () => ({}) },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Tool schema used to force structured JSON output from the Tier 2 LLM.
 * Mirrors the consent-monitor's `report_objection` tool pattern — the
 * same provider abstraction works for both, we just differ on the
 * schema.
 */
const CHAT_OPPORTUNITY_TOOL: ToolDefinitionShape = {
  name: "report_chat_opportunity",
  description:
    "Report whether the AI assistant chiming in via meeting chat would be appropriate and helpful here.",
  input_schema: {
    type: "object" as const,
    properties: {
      shouldRespond: {
        type: "boolean",
        description:
          "True if the AI assistant should post a helpful chat response now; false otherwise.",
      },
      reason: {
        type: "string",
        description:
          "Brief rationale for the decision. For positive verdicts, a one-line description of what the assistant should address; for negative verdicts, why intervention is inappropriate.",
      },
    },
    required: ["shouldRespond", "reason"],
  },
};

/**
 * Resolve a sub-module factory by name, throwing a clear error when the
 * registry entry is missing. The session manager depends on every
 * registered sub-module — a missing slot is a hard wiring bug, not a
 * recoverable condition.
 */
function resolveSubModuleFactory<F extends SubModuleFactory>(name: string): F {
  const factory = getSubModule<unknown>(name);
  if (!factory) {
    throw new Error(
      `meet-join/session-manager: sub-module "${name}" is not registered in modules-registry. ` +
        "Ensure the sub-module's file has been imported so its `registerSubModule(...)` ran at import time.",
    );
  }
  return factory as F;
}

/**
 * Substitute `{assistantName}` in a consent-message template. Safe against
 * empty templates and against names that happen to contain regex-magic
 * characters — uses a plain split/join rather than a RegExp. Mirrors the
 * helper in `meet-join-tool.ts` so direct callers of
 * {@link MeetSessionManager.join} (bypassing the tool) still get a
 * substituted greeting.
 */
export function substituteAssistantName(
  template: string,
  assistantName: string,
): string {
  return template.split("{assistantName}").join(assistantName);
}

/**
 * Best-effort: pull the bot container's accumulated stdout/stderr and
 * persist it to `<meetingDir>/bot.log` before the container is removed.
 * Called from every join-rollback path that has a containerId so a
 * post-mortem exists even after `runner.remove()` deletes the container.
 * Any Docker-side failure (container already gone, socket timeout, etc.)
 * is swallowed — log capture must never mask the original join error.
 */
async function captureBotLogs(
  runner: { logs: (id: string) => Promise<string> },
  containerId: string,
  meetingDir: string,
  log: Logger,
): Promise<void> {
  try {
    const body = await runner.logs(containerId);
    const dest = join(meetingDir, "bot.log");
    writeFileSync(dest, body);
    log.info("Captured bot container logs before rollback", {
      containerId,
      dest,
      bytes: body.length,
    });
  } catch (err) {
    log.warn("Failed to capture bot container logs (continuing rollback)", {
      err,
      containerId,
      meetingDir,
    });
  }
}

function sessionView(session: ActiveSession): MeetSession {
  return {
    meetingId: session.meetingId,
    conversationId: session.conversationId,
    containerId: session.containerId,
    botBaseUrl: session.botBaseUrl,
    botApiToken: session.botApiToken,
    startedAt: session.startedAt,
    joinTimeoutMs: session.joinTimeoutMs,
  };
}

/**
 * Generate a cryptographically random bearer token for per-meeting bot auth.
 * 32 bytes → 64 hex chars — enough entropy for a shared secret.
 */
export function generateBotApiToken(): string {
  return randomBytes(32).toString("hex");
}

/** Extract a human-readable message from an unknown thrown value. */
function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown error";
}

/**
 * Default bot `/leave` hitter. Honors {@link BOT_LEAVE_HTTP_TIMEOUT_MS}.
 * Throws on non-2xx or timeout so `leave()` can fall through to stop.
 */
async function defaultBotLeaveFetch(url: string, token: string): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(BOT_LEAVE_HTTP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `Bot /leave returned ${response.status}: ${await response.text().catch(() => "")}`,
    );
  }
}

/**
 * Default bot `/send_chat` hitter. Honors
 * {@link BOT_SEND_CHAT_HTTP_TIMEOUT_MS}. On network-level failure throws
 * {@link MeetSessionUnreachableError}; on non-2xx throws
 * {@link MeetBotChatError} so the tool layer can distinguish the two.
 */
async function defaultBotSendChatFetch(
  url: string,
  token: string,
  text: string,
  meetingId: string,
): Promise<void> {
  // xdotool types at 25ms/char inside the bot container, so the bot's
  // reply genuinely cannot arrive before `text.length * 25ms` — a fixed
  // 10s ceiling times out valid sub-2000-char chats above ~390 chars
  // even when the extension eventually completes them successfully.
  // Scale per request via the shared helper; floor at the legacy fixed
  // budget so short messages keep the same (already-tight) ceiling.
  //
  // Clamp the length used for timeout sizing at Meet's 2000-char chat
  // cap. The bot's `/send_chat` handler rejects anything longer, so a
  // pathological oversized payload (e.g. 10k chars) must not inflate
  // unreachable-bot latency from ~65s to ~265s+ before surfacing
  // `MeetSessionUnreachableError`.
  const clampedLength = Math.min(text.length, MEET_CHAT_MAX_LENGTH);
  const timeoutMs = Math.max(
    BOT_SEND_CHAT_HTTP_TIMEOUT_MS,
    trustedTypeHttpTimeoutMs(clampedLength),
  );
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "send_chat", text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new MeetSessionUnreachableError(meetingId, detail);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new MeetBotChatError(meetingId, response.status, body);
  }
}

/**
 * Default bot `/avatar/{enable,disable}` hitter. Honors
 * {@link BOT_AVATAR_HTTP_TIMEOUT_MS}. On network-level failure throws
 * {@link MeetSessionUnreachableError}; on non-2xx throws
 * {@link MeetBotAvatarError} so the tool layer can surface the upstream
 * status (e.g. 503 when the renderer is unavailable on this host).
 *
 * Parses the 2xx body as JSON and returns it verbatim so callers can
 * relay useful fields (e.g. `alreadyRunning`, `renderer`, `cameraChanged`)
 * back to the model. A body that fails to parse as JSON is coerced to an
 * empty object rather than throwing — the endpoint is defined to return
 * JSON on success, but an empty-body / non-JSON 2xx is still a success
 * from the caller's perspective.
 */
async function defaultBotAvatarFetch(
  url: string,
  token: string,
  endpoint: string,
  meetingId: string,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(BOT_AVATAR_HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new MeetSessionUnreachableError(meetingId, detail);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new MeetBotAvatarError(meetingId, endpoint, response.status, body);
  }
  const parsed = (await response.json().catch(() => ({}))) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

/**
 * Resolve the daemon URL the bot container should use to post events back
 * to the host. Docker containers reach the host via
 * `host.docker.internal`; the port comes from `RUNTIME_HTTP_PORT` with a
 * fallback to the default.
 */
function defaultResolveDaemonUrl(): string {
  const portRaw = process.env.RUNTIME_HTTP_PORT;
  const port = portRaw ? Number.parseInt(portRaw, 10) : DEFAULT_DAEMON_PORT;
  const effectivePort =
    Number.isFinite(port) && port > 0 ? port : DEFAULT_DAEMON_PORT;
  return `http://host.docker.internal:${effectivePort}`;
}
