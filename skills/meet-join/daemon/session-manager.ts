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
 *     manager, PR 17's conversation bridge, PR 18's storage writer,
 *     PR 22's consent monitor) can observe the same live event stream.
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

import { getConfig } from "../../../assistant/src/config/loader.js";
import { getAssistantName } from "../../../assistant/src/daemon/identity-helpers.js";
import { addMessage } from "../../../assistant/src/memory/conversation-crud.js";
import {
  createTimeout,
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../../../assistant/src/providers/provider-send-message.js";
import type {
  Provider,
  ToolDefinition,
} from "../../../assistant/src/providers/types.js";
import { wakeAgentForOpportunity } from "../../../assistant/src/runtime/agent-wake.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../../assistant/src/runtime/assistant-scope.js";
import type { DaemonRuntimeMode } from "../../../assistant/src/runtime/runtime-mode.js";
import { getDaemonRuntimeMode } from "../../../assistant/src/runtime/runtime-mode.js";
import { getProviderKeyAsync } from "../../../assistant/src/security/secure-keys.js";
import { getTtsProvider } from "../../../assistant/src/tts/provider-registry.js";
import { resolveTtsConfig } from "../../../assistant/src/tts/tts-config-resolver.js";
import type { TtsProvider } from "../../../assistant/src/tts/types.js";
import { getLogger } from "../../../assistant/src/util/logger.js";
import { getWorkspaceDir } from "../../../assistant/src/util/platform.js";
import { getMeetConfig } from "../meet-config.js";
import { MeetAudioIngest } from "./audio-ingest.js";
import {
  type BargeInCanceller,
  MeetBargeInWatcher,
} from "./barge-in-watcher.js";
import {
  type ChatOpportunityDecision,
  type ChatOpportunityDetectorStats,
  type ChatOpportunityLLMAsk,
  MeetChatOpportunityDetector,
  type ProactiveChatConfig,
} from "./chat-opportunity-detector.js";
import {
  MeetConsentMonitor,
  type MeetSessionLeaver,
} from "./consent-monitor.js";
import {
  type InsertMessageFn,
  MeetConversationBridge,
} from "./conversation-bridge.js";
import {
  DockerRunner,
  MEET_BOT_LABEL,
  MEET_BOT_MEETING_ID_LABEL,
  reapOrphanedMeetBots,
  type DockerRunResult,
} from "./docker-runner.js";
import {
  meetEventDispatcher,
  type MeetEventUnsubscribe,
  publishMeetEvent,
  registerMeetingDispatcher,
  subscribeEventHubPublisher,
  subscribeToMeetingEvents,
  unregisterMeetingDispatcher,
} from "./event-publisher.js";
import { getMeetSessionEventRouter } from "./session-event-router.js";
import { MeetStorageWriter, type PcmSource } from "./storage-writer.js";
import {
  MeetTtsBridge,
  type MeetTtsBridgeArgs,
  type MeetTtsBridgeDeps,
  MeetTtsCancelledError,
  type SpeakInput,
} from "./tts-bridge.js";
import {
  startTtsLipsync,
  type StartTtsLipsyncArgs,
  type TtsLipsyncHandle,
} from "./tts-lipsync.js";

const log = getLogger("meet-session-manager");

/** Default internal port the bot's control API listens on inside the container. */
export const MEET_BOT_INTERNAL_PORT = 3000;

/** Default host interface to bind the bot's published port to. */
export const MEET_BOT_HOST_IP = "127.0.0.1";

/** Timeout for the best-effort bot `/leave` HTTP call before falling back to stop. */
export const BOT_LEAVE_HTTP_TIMEOUT_MS = 10_000;

/** Timeout for the bot `/send_chat` HTTP call before giving up. */
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
 * In Docker mode the CLI must bind-mount the host device into the assistant
 * container on hatch/wake — opt-in via `VELLUM_MEET_AVATAR=1`. If an
 * operator enables the avatar in config without setting the env var, the
 * daemon's Docker Engine API `--device` pass-through would otherwise fail
 * much later with a cryptic "device not found" error from the inner
 * `dockerd`. This class surfaces the root cause at meet-join time with an
 * actionable pointer at the CLI env-var.
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
        `In Docker mode, set VELLUM_MEET_AVATAR=1 in the CLI environment before spawning the instance so the CLI bind-mounts the device. ` +
        `If you changed services.meet.avatar.devicePath from the default, also set VELLUM_MEET_AVATAR_DEVICE to the same path.`,
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
  start(meetingId: string, socketPath: string): Promise<void>;
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
 */
export interface MeetTtsBridgeLike {
  speak(
    input: SpeakInput,
  ): Promise<{ streamId: string; completion: Promise<void> }>;
  cancel(streamId: string): Promise<void>;
  cancelAll(): Promise<void>;
  activeStreamCount(): number;
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
  assistantId: string;
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
  callDetectorLLM: ChatOpportunityLLMAsk;
  onOpportunity: (hint: string) => void;
}

export interface MeetSessionManagerDeps {
  /** Factory for the Docker runner — swapped in tests. */
  dockerRunnerFactory?: () => Pick<
    DockerRunner,
    "run" | "stop" | "remove" | "inspect" | "logs" | "kill" | "listContainers"
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

  constructor(deps: MeetSessionManagerDeps = {}) {
    const insertMessage = deps.insertMessage ?? addMessage;
    const resolveWorkspaceDir = deps.getWorkspaceDir ?? getWorkspaceDir;
    this.deps = {
      dockerRunnerFactory:
        deps.dockerRunnerFactory ??
        (() => new DockerRunner({ workspaceDir: resolveWorkspaceDir() })),
      getProviderKey: deps.getProviderKey ?? getProviderKeyAsync,
      botLeaveFetch: deps.botLeaveFetch ?? defaultBotLeaveFetch,
      botSendChatFetch: deps.botSendChatFetch ?? defaultBotSendChatFetch,
      botAvatarFetch: deps.botAvatarFetch ?? defaultBotAvatarFetch,
      resolveDaemonUrl: deps.resolveDaemonUrl ?? defaultResolveDaemonUrl,
      getWorkspaceDir: deps.getWorkspaceDir ?? getWorkspaceDir,
      audioIngestFactory:
        deps.audioIngestFactory ?? (() => new MeetAudioIngest()),
      consentMonitorFactory:
        deps.consentMonitorFactory ?? defaultConsentMonitorFactory,
      conversationBridgeFactory:
        deps.conversationBridgeFactory ??
        ((args) =>
          new MeetConversationBridge({
            meetingId: args.meetingId,
            conversationId: args.conversationId,
            insertMessage,
          })),
      storageWriterFactory:
        deps.storageWriterFactory ??
        ((args) => new MeetStorageWriter(args.meetingId)),
      resolveAssistantDisplayName:
        deps.resolveAssistantDisplayName ?? getAssistantName,
      insertMessage,
      chatOpportunityDetectorFactory:
        deps.chatOpportunityDetectorFactory ??
        defaultChatOpportunityDetectorFactory,
      ttsBridgeFactory: deps.ttsBridgeFactory ?? defaultTtsBridgeFactory,
      ttsLipsyncFactory: deps.ttsLipsyncFactory ?? defaultTtsLipsyncFactory,
      bargeInWatcherFactory:
        deps.bargeInWatcherFactory ?? defaultBargeInWatcherFactory,
      wakeAgent: deps.wakeAgent ?? defaultWakeAgent,
      resolveRuntimeMode: deps.resolveRuntimeMode ?? getDaemonRuntimeMode,
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

    // One-shot startup orphan sweep. On a fresh boot no sessions exist, so
    // the active-id set is empty — any `vellum.meet.bot`-labeled container
    // still running came from a crashed prior daemon run and must be
    // reaped. Fire-and-forget so construction stays synchronous; the
    // reaper logs its own outcome and catches per-container errors so a
    // transient docker-engine hiccup never tears down the session-manager
    // singleton. Tests opt out via {@link MeetSessionManagerDeps.disableStartupOrphanReaper}.
    if (!this.deps.disableStartupOrphanReaper) {
      const reaperDocker = this.deps.dockerRunnerFactory();
      void reapOrphanedMeetBots({
        docker: reaperDocker,
        activeMeetingIds: new Set<string>(),
        logger: log,
      }).catch((err: unknown) => {
        log.warn({ err }, "Startup orphan-reaper sweep threw — continuing");
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
   * (`cli/src/lib/docker.ts`) is responsible for bind-mounting it, gated
   * on `VELLUM_MEET_AVATAR=1`. If the config enables the avatar but the
   * CLI opt-in is missing, the device will not exist inside the container
   * and the downstream `DockerRunner.run()` would fail with a cryptic
   * "device not found" error from the inner `dockerd`. This check moves
   * the failure to a deterministic point (meet-join time) with a clear
   * pointer at the env-var the operator forgot to set.
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
    await publishMeetEvent(
      DAEMON_INTERNAL_ASSISTANT_ID,
      meetingId,
      "meet.joining",
      { url },
    );

    let meet: ReturnType<typeof getMeetConfig>;
    let workspaceDir: string;
    let meetingDir: string;
    let socketsDir: string;
    let outDir: string;
    let botApiToken: string;
    let ttsKey: string;
    try {
      meet = getMeetConfig();

      // Preflight: in Docker mode, avatar config + CLI env-var opt-in are
      // two orthogonal controls (see `cli/src/lib/docker.ts`'s
      // `VELLUM_MEET_AVATAR` handling). Fail fast here with a pointer at
      // the env-var rather than letting the inner `dockerd` reject the
      // bot-container create with an opaque "device not found" error.
      if (meet.avatar.enabled) {
        this.assertAvatarDeviceAvailable(meet.avatar.devicePath);
      }

      workspaceDir = this.deps.getWorkspaceDir();
      meetingDir = join(workspaceDir, "meets", meetingId);
      socketsDir = join(meetingDir, "sockets");
      outDir = join(meetingDir, "out");
      mkdirSync(socketsDir, { recursive: true });
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
      void publishMeetEvent(
        DAEMON_INTERNAL_ASSISTANT_ID,
        meetingId,
        "meet.error",
        { detail: errorDetail(err) },
      );
      throw err;
    }

    try {
      // Placeholder — Phase 3 (PR 23+) will resolve the real TTS credential.
      ttsKey = (await this.deps.getProviderKey("tts")) ?? "";
    } catch (err) {
      void publishMeetEvent(
        DAEMON_INTERNAL_ASSISTANT_ID,
        meetingId,
        "meet.error",
        { detail: errorDetail(err) },
      );
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
      void publishMeetEvent(
        DAEMON_INTERNAL_ASSISTANT_ID,
        meetingId,
        "meet.error",
        { detail: errorDetail(err) },
      );
      throw err;
    }

    // Register the dispatcher BEFORE the audio-ingest starts so transcripts
    // fired by Deepgram the instant the streaming session opens cannot race
    // ahead of the router handler and end up in the "dropping event for
    // unregistered meeting" path. The ingest opens the STT session as part
    // of `start()`, which may begin emitting partials immediately.
    registerMeetingDispatcher(meetingId);

    // Audio ingest + container spawn are started concurrently:
    //   1. The ingest opens its Unix-socket server and a streaming STT
    //      session (provider resolved from `services.stt.provider` via
    //      the provider catalog), then waits for the bot to connect
    //      (bounded by a 30s timeout).
    //   2. The container is started in parallel; once it boots, the bot
    //      process inside dials the shared socket.
    //
    // Starting the ingest first (i.e. before `runner.run()` returns) is
    // what lets the bot connect as soon as its process comes up. Running
    // them concurrently keeps the total latency bounded — the join
    // completes once both steps succeed, or fails fast if either step
    // rejects (e.g. with a {@link MeetAudioIngestError} when no
    // streaming-capable STT provider is configured).
    const audioSocketPath = join(socketsDir, "audio.sock");
    const audioIngest = this.deps.audioIngestFactory();
    const audioIngestPromise = audioIngest.start(meetingId, audioSocketPath);
    // Guard the ingest promise immediately so a rejection between here and
    // the first explicit `await audioIngestPromise` (after `runner.run()`)
    // does not surface as an unhandled rejection. The global handler in
    // `shutdown-handlers.ts` calls `process.exit(1)` on unhandled
    // rejections, so without this guard a transient STT failure during
    // container spawn would crash the entire daemon.
    audioIngestPromise.catch(() => {});

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
      // STT credentials live on the daemon, not the bot — bot connects via Unix socket.
      TTS_API_KEY: ttsKey,
      // Enable the in-container Pulse null-sink by default (set to "1" to
      // disable in dev). Match the meet-bot image expectation.
      SKIP_PULSE: "0",
    };

    // Avatar config → bot env.
    //
    // When the avatar feature is enabled we thread the config down to the
    // bot via a trio of env vars:
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
    // Credential fields inside the config are resolved to raw values in
    // the daemon (via the vault) before being handed off — the bot has
    // no vault access. Concrete renderer PRs extend this serialization
    // step to substitute in their own vault-resolved credentials.
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
        // Session-manager stays mode-agnostic — the only thing we rely on
        // is that the directories exist under the daemon's view of the
        // workspace so the audio-ingest socket path lines up with what the
        // bot sees inside its container.
        workspaceMounts: [
          { target: "/sockets", subpath: `meets/${meetingId}/sockets` },
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
        // full label scheme + reaper contract.
        labels: {
          [MEET_BOT_LABEL]: "true",
          [MEET_BOT_MEETING_ID_LABEL]: meetingId,
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
      log.error(
        { err, meetingId, image: meet.containerImage },
        "Failed to spawn meet bot container",
      );
      // Tear down the concurrently-started audio ingest so we don't leak
      // a listening socket or a streaming STT session on the spawn-failure path.
      await audioIngest.stop().catch(() => {});
      unregisterMeetingDispatcher(meetingId);
      this.pendingBotTokens.delete(meetingId);
      void publishMeetEvent(
        DAEMON_INTERNAL_ASSISTANT_ID,
        meetingId,
        "meet.error",
        { detail: errorDetail(err) },
      );
      throw err;
    }

    const boundPort = runResult.boundPorts.find(
      (p) => p.containerPort === MEET_BOT_INTERNAL_PORT,
    );
    if (!boundPort) {
      // Roll back the container so we don't leak a started-but-unreachable
      // bot. Best-effort — surface the original error either way.
      await captureBotLogs(runner, runResult.containerId, meetingDir);
      await runner.remove(runResult.containerId).catch(() => {});
      await audioIngest.stop().catch(() => {});
      unregisterMeetingDispatcher(meetingId);
      this.pendingBotTokens.delete(meetingId);
      const detail = `meet-bot container ${runResult.containerId} did not publish a host port for ${MEET_BOT_INTERNAL_PORT}/tcp`;
      void publishMeetEvent(
        DAEMON_INTERNAL_ASSISTANT_ID,
        meetingId,
        "meet.error",
        { detail },
      );
      throw new Error(detail);
    }

    // Now that the container is up, wait for the ingest to finish setup
    // (streaming STT session opened + bot connected via the shared
    // socket). If the bot never connects within the 30s timeout — or the
    // ingest fails to open a streaming session (e.g. no STT provider
    // configured; surfaced as `MeetAudioIngestError`) — the promise
    // rejects and we roll the container back before re-throwing. The
    // error's `message` is forwarded to the caller via both the `throw`
    // and the `meet.error` event, so the user sees a pointer at
    // `services.stt.provider` when that's the cause.
    try {
      await audioIngestPromise;
    } catch (err) {
      log.error(
        { err, meetingId, containerId: runResult.containerId },
        "Meet audio ingest failed to start — rolling back container",
      );
      await runner.stop(runResult.containerId).catch(() => {});
      await captureBotLogs(runner, runResult.containerId, meetingDir);
      await runner.remove(runResult.containerId).catch(() => {});
      await audioIngest.stop().catch(() => {});
      unregisterMeetingDispatcher(meetingId);
      this.pendingBotTokens.delete(meetingId);
      void publishMeetEvent(
        DAEMON_INTERNAL_ASSISTANT_ID,
        meetingId,
        "meet.error",
        { detail: errorDetail(err) },
      );
      throw err;
    }

    const botBaseUrl = `http://${MEET_BOT_HOST_IP}:${boundPort.hostPort}`;
    const joinTimeoutMs = meet.maxMeetingMinutes * 60_000;

    // Consent monitor is constructed before the session record so it can
    // be torn down deterministically from `leave()` — it subscribes on
    // `start()` below, after the session is in the map.
    const consentMonitor = this.deps.consentMonitorFactory({
      meetingId,
      assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
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
    // and wakes the agent loop on positive Tier 2 verdicts. Constructed
    // only when `services.meet.proactiveChat.enabled === true`; keeping
    // the detector null when disabled means zero lifecycle overhead and
    // no event-handler cost on the dispatcher path.
    const proactiveChatConfig = meet.proactiveChat;
    const chatOpportunityDetector: MeetChatOpportunityDetectorLike | null =
      proactiveChatConfig.enabled
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
            callDetectorLLM: defaultCallDetectorLLM,
            onOpportunity: (hint: string) => {
              void this.deps
                .wakeAgent({
                  conversationId,
                  hint,
                  source: "meet-chat-opportunity",
                })
                .catch((err) => {
                  log.warn(
                    { err, meetingId, conversationId },
                    "MeetChatOpportunityDetector: wakeAgent rejected — dropping opportunity",
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
    };
    this.sessions.set(meetingId, session);
    // `this.sessions` is now the authoritative source for the resolver;
    // the pre-registered pending entry is no longer needed.
    this.pendingBotTokens.delete(meetingId);

    // Fan `participant.change` / `speaker.change` / final transcript chunks
    // out as `meet.*` events on the assistant event hub.
    session.eventUnsubscribes.push(
      subscribeEventHubPublisher(DAEMON_INTERNAL_ASSISTANT_ID, meetingId),
    );

    // Watch for the bot's first `lifecycle: joined` so we can emit a
    // client-facing `meet.joined` at the precise moment the bot is live
    // in the meeting. Lifecycle publish happens once per session.
    session.eventUnsubscribes.push(
      subscribeToMeetingEvents(meetingId, (event) => {
        if (event.type !== "lifecycle") return;
        if (event.state === "joined" && !session.joinedPublished) {
          session.joinedPublished = true;
          void publishMeetEvent(
            DAEMON_INTERNAL_ASSISTANT_ID,
            meetingId,
            "meet.joined",
            {},
          );
          return;
        }
        if (event.state === "error") {
          void publishMeetEvent(
            DAEMON_INTERNAL_ASSISTANT_ID,
            meetingId,
            "meet.error",
            { detail: event.detail ?? "unknown error" },
          );
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
      log.error(
        { err, meetingId, containerId: runResult.containerId },
        "Bridge/writer subscribe failed — rolling back container and audio ingest",
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
      await captureBotLogs(runner, runResult.containerId, meetingDir);
      await runner.remove(runResult.containerId).catch(() => {});
      void publishMeetEvent(
        DAEMON_INTERNAL_ASSISTANT_ID,
        meetingId,
        "meet.error",
        { detail: errorDetail(err) },
      );
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
      log.warn(
        { err, meetingId },
        "MeetStorageWriter.startAudio failed — continuing without audio capture",
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
        log.error(
          { err, meetingId },
          "Error during max-meeting-minutes timeout cleanup",
        );
      });
    }, joinTimeoutMs);

    // NOTE: a container-exit watcher still belongs here in a future PR —
    // it would catch `docker stop`-driven exits that never emit a
    // `lifecycle: left` event and synthesize a `meet.error` so the client
    // doesn't hang in "joined" forever. Leaving as a follow-up; the
    // timeout cap + explicit `leave()` path already cover the normal
    // teardown routes.

    log.info(
      {
        meetingId,
        conversationId,
        containerId: runResult.containerId,
        botBaseUrl,
        joinTimeoutMs,
      },
      "Meet session joined",
    );

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
      log.debug({ meetingId, reason }, "leave(): no active session — no-op");
      return;
    }

    // Stop the consent monitor first — any pending LLM call can finish
    // harmlessly since `decided` is the only write path it has to the
    // session manager, and we've already committed to leaving. This also
    // clears the 20s tick timer so it can't fire during teardown.
    try {
      session.consentMonitor.stop();
    } catch (err) {
      log.warn(
        { err, meetingId },
        "MeetConsentMonitor.stop threw during leave — continuing teardown",
      );
    }

    // Dispose the chat-opportunity detector alongside the consent monitor
    // so no late transcript/chat event fires an agent wake during
    // teardown. Safe when the detector is null (proactive chat disabled).
    try {
      session.chatOpportunityDetector?.dispose();
    } catch (err) {
      log.warn(
        { err, meetingId },
        "MeetChatOpportunityDetector.dispose threw during leave — continuing teardown",
      );
    }

    // Stop the barge-in watcher before we cancel any in-flight TTS so the
    // synthetic `meet.speaking_ended` events emitted by `cancelAll` below
    // don't trigger any dispatcher work in the watcher. Also clears any
    // pending debounced cancel that hasn't fired yet.
    try {
      session.bargeInWatcher.stop();
    } catch (err) {
      log.warn(
        { err, meetingId },
        "MeetBargeInWatcher.stop threw during leave — continuing teardown",
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
      log.warn(
        { err, meetingId },
        "TtsLipsyncHandle.stop threw during leave — continuing teardown",
      );
    }

    // Cancel any in-flight TTS streams so orphan playback doesn't try to
    // talk to a bot container that's about to be removed. `cancelAll`
    // awaits the per-stream teardown (which includes the best-effort
    // DELETE /play_audio/<id>) — bounded by the stream's own abort path.
    try {
      await session.ttsBridge.cancelAll();
    } catch (err) {
      log.warn(
        { err, meetingId },
        "MeetTtsBridge.cancelAll threw during leave — continuing teardown",
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
      log.warn(
        { err, meetingId },
        "Meet synthesized lifecycle:left dispatch threw during leave",
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
      log.warn(
        { err, meetingId },
        "MeetConversationBridge.unsubscribe threw during leave",
      );
    }
    try {
      await session.storageWriter.stop();
    } catch (err) {
      log.warn({ err, meetingId }, "MeetStorageWriter.stop threw during leave");
    }

    // Tear down dispatcher subscribers BEFORE unregistering the router so no
    // in-flight event slips through to a subscriber whose consumer is gone.
    for (const unsubscribe of session.eventUnsubscribes) {
      try {
        unsubscribe();
      } catch (err) {
        log.warn(
          { err, meetingId },
          "Meet event subscriber unsubscribe threw during leave",
        );
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
      log.warn(
        { err, meetingId, reason },
        "Bot /leave failed or timed out — falling back to container stop",
      );
    }

    if (!gracefulOk) {
      try {
        await runner.stop(session.containerId);
      } catch (err) {
        log.warn(
          { err, meetingId, containerId: session.containerId },
          "DockerRunner.stop failed — proceeding to remove",
        );
      }
    }

    try {
      await runner.remove(session.containerId);
    } catch (err) {
      log.warn(
        { err, meetingId, containerId: session.containerId },
        "DockerRunner.remove failed — container may leak",
      );
    }

    // Tear down the audio-ingest after the container is gone — stopping it
    // earlier would force the bot's outbound audio writes to fail while
    // the container is still shutting down.
    try {
      await session.audioIngest.stop();
    } catch (err) {
      log.warn(
        { err, meetingId },
        "MeetAudioIngest.stop failed — socket or streaming STT session may leak",
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

    void publishMeetEvent(
      DAEMON_INTERNAL_ASSISTANT_ID,
      meetingId,
      "meet.left",
      { reason },
    );

    log.info(
      {
        meetingId,
        containerId: session.containerId,
        reason,
        gracefulOk,
        chatOpportunityStats: chatStats,
      },
      "Meet session left",
    );
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

    void publishMeetEvent(
      DAEMON_INTERNAL_ASSISTANT_ID,
      meetingId,
      "meet.chat_sent",
      { text },
    );

    log.info({ meetingId, textLength: text.length }, "Meet chat message sent");
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

    void publishMeetEvent(
      DAEMON_INTERNAL_ASSISTANT_ID,
      meetingId,
      "meet.speaking_started",
      { streamId },
    );

    // Fire-and-forget completion publisher. `result.completion` resolves
    // when the outbound POST settles (either success, cancel, or error);
    // errors are rethrown from the bridge so we can distinguish a natural
    // finish from a rejected one and emit the matching reason.
    void result.completion
      .then(() => {
        void publishMeetEvent(
          DAEMON_INTERNAL_ASSISTANT_ID,
          meetingId,
          "meet.speaking_ended",
          { streamId, reason: "completed" as const },
        );
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
          log.debug(
            { meetingId, streamId, reason },
            "MeetTtsBridge speak cancelled",
          );
        } else {
          log.warn(
            { err, meetingId, streamId, reason },
            "MeetTtsBridge speak completion rejected",
          );
        }
        void publishMeetEvent(
          DAEMON_INTERNAL_ASSISTANT_ID,
          meetingId,
          "meet.speaking_ended",
          { streamId, reason },
        );
      });

    log.info(
      { meetingId, streamId, textLength: input.text.length },
      "Meet TTS speak started",
    );

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

    log.info({ meetingId, body }, "Meet avatar enabled");
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

    log.info({ meetingId, body }, "Meet avatar disabled");
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

    log.info(
      { count: snapshot.length, reason, totalDeadlineMs },
      "MeetSessionManager: shutting down active sessions",
    );

    // Fire all leaves in parallel. Track which have resolved so we can
    // identify stragglers after the deadline expires. `leave()` catches
    // its own teardown errors, but we guard again here in case a refactor
    // changes that.
    const resolved = new Set<string>();
    const leaves = snapshot.map((entry) =>
      this.leave(entry.meetingId, reason)
        .catch((err) => {
          log.warn(
            { err, meetingId: entry.meetingId, reason },
            "MeetSessionManager.shutdownAll: leave() rejected — continuing",
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
      log.warn(
        {
          count: stragglers.length,
          reason,
          totalDeadlineMs,
        },
        "MeetSessionManager.shutdownAll: deadline exceeded — force-stopping containers",
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
          log.warn(
            { err, meetingId: entry.meetingId, containerId: entry.containerId },
            "MeetSessionManager.shutdownAll: runner.stop threw",
          );
        }
        try {
          await runner.remove(entry.containerId);
        } catch (err) {
          log.warn(
            { err, meetingId: entry.meetingId, containerId: entry.containerId },
            "MeetSessionManager.shutdownAll: runner.remove threw",
          );
        }
        try {
          await entry.audioIngest.stop();
        } catch (err) {
          log.warn(
            { err, meetingId: entry.meetingId },
            "MeetSessionManager.shutdownAll: audioIngest.stop threw",
          );
        }
      });
      await Promise.allSettled(forced);
    }

    log.info(
      { outcome, reason },
      "MeetSessionManager: active-session shutdown complete",
    );
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Process-wide session manager. */
export const MeetSessionManager = new MeetSessionManagerImpl();

/** Exposed for integration tests that need a clean instance. */
export function _createMeetSessionManagerForTests(
  deps?: MeetSessionManagerDeps,
): MeetSessionManagerImpl {
  // Default to disabling the startup orphan-reaper sweep in tests — most
  // tests supply a narrow mock runner that only implements the
  // `run`/`stop`/`remove`/`inspect`/`logs` surface used by the
  // join/leave path. Tests that want to exercise the reaper can override
  // by passing `disableStartupOrphanReaper: false`.
  return new MeetSessionManagerImpl({
    disableStartupOrphanReaper: true,
    ...deps,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Default {@link MeetConsentMonitor} factory — constructs a monitor wired
 * to the production LLM path. Swapped out in tests via
 * {@link MeetSessionManagerDeps.consentMonitorFactory}.
 */
function defaultConsentMonitorFactory(
  args: MeetConsentMonitorFactoryArgs,
): MeetConsentMonitorLike {
  return new MeetConsentMonitor({
    meetingId: args.meetingId,
    assistantId: args.assistantId,
    sessionManager: args.sessionManager,
    config: args.config,
  });
}

/**
 * Default {@link MeetChatOpportunityDetector} factory. The Tier 2 LLM
 * callback is injected from module scope (see
 * {@link defaultCallDetectorLLM}) rather than baked into the detector
 * itself so tests can swap the whole factory when they want to avoid
 * the provider stack entirely.
 */
function defaultChatOpportunityDetectorFactory(
  args: MeetChatOpportunityDetectorFactoryArgs,
): MeetChatOpportunityDetectorLike {
  return new MeetChatOpportunityDetector({
    meetingId: args.meetingId,
    assistantDisplayName: args.assistantDisplayName,
    config: args.config,
    callDetectorLLM: args.callDetectorLLM,
    onOpportunity: args.onOpportunity,
  });
}

/**
 * Tool schema used to force structured JSON output from the Tier 2 LLM.
 * Mirrors the consent-monitor's `report_objection` tool pattern — the
 * same provider abstraction works for both, we just differ on the
 * schema.
 */
const CHAT_OPPORTUNITY_TOOL: ToolDefinition = {
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
 * Default Tier 2 chat-opportunity LLM callback. Routes through the
 * repo-wide provider abstraction under the `meetChatOpportunity` call
 * site, keeping the proactive-chat path on its own configurable lane
 * alongside the consent monitor. Times out at
 * {@link CHAT_OPPORTUNITY_LLM_TIMEOUT_MS} and extracts the tool-use
 * input as the structured verdict.
 *
 * On missing provider or malformed output we fall back to a conservative
 * `shouldRespond: false` verdict — never interrupt a meeting because of
 * missing infrastructure.
 */
async function defaultCallDetectorLLM(
  prompt: string,
): Promise<ChatOpportunityDecision> {
  const provider: Provider | null = await getConfiguredProvider(
    "meetChatOpportunity",
  );
  if (!provider) {
    return { shouldRespond: false, reason: "" };
  }

  const { signal, cleanup } = createTimeout(CHAT_OPPORTUNITY_LLM_TIMEOUT_MS);
  try {
    const response = await provider.sendMessage(
      [userMessage(prompt)],
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
    const tool = extractToolUse(response);
    if (!tool) return { shouldRespond: false, reason: "" };
    const input = tool.input as { shouldRespond?: unknown; reason?: unknown };
    return {
      shouldRespond: input.shouldRespond === true,
      reason: typeof input.reason === "string" ? input.reason : "",
    };
  } finally {
    cleanup();
  }
}

/**
 * Default {@link MeetTtsBridge} factory — resolves the TTS provider from
 * the registry using `services.tts.provider` on each `speak` call so
 * config-live provider changes propagate without needing to rebuild the
 * bridge. Tests can inject a fake via
 * {@link MeetSessionManagerDeps.ttsBridgeFactory}.
 */
function defaultTtsBridgeFactory(
  args: MeetTtsBridgeFactoryArgs,
): MeetTtsBridgeLike {
  const bridgeArgs: MeetTtsBridgeArgs = {
    meetingId: args.meetingId,
    botBaseUrl: args.botBaseUrl,
    botApiToken: args.botApiToken,
  };
  const bridgeDeps: MeetTtsBridgeDeps = {
    providerFactory: (): TtsProvider => {
      const resolved = resolveTtsConfig(getConfig());
      return getTtsProvider(resolved.provider);
    },
  };
  return new MeetTtsBridge(bridgeArgs, bridgeDeps);
}

/**
 * Default {@link startTtsLipsync} factory — subscribes to the bridge's
 * viseme channel and forwards every event to the bot's `/avatar/viseme`
 * endpoint. The forwarder tolerates bot-side HTTP errors (404 before
 * PR 5's route is deployed, 5xx during transient failures) internally, so
 * the session manager never observes a rejection from this path. Tests
 * can inject a fake via {@link MeetSessionManagerDeps.ttsLipsyncFactory}
 * to observe start/stop without touching the bridge's emit path or the
 * bot HTTP surface. The default cast is only safe because
 * {@link MeetTtsBridgeLike} is a strict subset of the {@link MeetTtsBridge}
 * shape {@link startTtsLipsync} reads — `onViseme`, `botBaseUrl`, and
 * `meetingId` are only accessed through the real bridge instance, not
 * through the narrow session-manager interface.
 */
function defaultTtsLipsyncFactory(
  args: MeetTtsLipsyncFactoryArgs,
): TtsLipsyncHandle {
  const lipsyncArgs: StartTtsLipsyncArgs = {
    bridge: args.bridge as unknown as MeetTtsBridge,
    botApiToken: args.botApiToken,
  };
  return startTtsLipsync(lipsyncArgs);
}

/**
 * Default {@link MeetBargeInWatcher} factory — wires the watcher to the
 * production dispatcher + assistant-event-hub. Tests can inject a fake
 * via {@link MeetSessionManagerDeps.bargeInWatcherFactory}.
 */
function defaultBargeInWatcherFactory(
  args: MeetBargeInWatcherFactoryArgs,
): MeetBargeInWatcherLike {
  return new MeetBargeInWatcher({
    meetingId: args.meetingId,
    sessionManager: args.sessionManager,
  });
}

/**
 * Default wake-agent invocation used by the chat-opportunity detector's
 * `onOpportunity` callback. Delegates to the runtime-level
 * {@link wakeAgentForOpportunity}, which resolves the target
 * conversation via the process-wide default resolver installed at
 * daemon startup (see `server.ts`).
 *
 * Accepts and discards the wake result so the detector's callback
 * signature stays `void`. Errors bubble to the detector's own
 * `onOpportunity` error-handling path, which logs and drops.
 */
async function defaultWakeAgent(opts: {
  conversationId: string;
  hint: string;
  source: string;
}): Promise<void> {
  await wakeAgentForOpportunity(opts);
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
): Promise<void> {
  try {
    const body = await runner.logs(containerId);
    const dest = join(meetingDir, "bot.log");
    writeFileSync(dest, body);
    log.info(
      { containerId, dest, bytes: body.length },
      "Captured bot container logs before rollback",
    );
  } catch (err) {
    log.warn(
      { err, containerId, meetingDir },
      "Failed to capture bot container logs (continuing rollback)",
    );
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
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "send_chat", text }),
      signal: AbortSignal.timeout(BOT_SEND_CHAT_HTTP_TIMEOUT_MS),
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
