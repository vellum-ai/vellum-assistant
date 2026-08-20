/**
 * The client half of a watch session: the microphone, the socket, and the one
 * bit of state that says whether either is open.
 *
 * A watch session is the user narrating a task while they work, with the
 * daemon reading their screen around what they say
 * (`assistant/src/watch/watch-session-manager.ts`). The runtime owns the
 * cadence, the observations, and the timeline; this module owns nothing but
 * the audio and the transport that carries it.
 *
 * **One session, held in the module rather than in a component.** The command
 * that starts a session arrives from the companion surface, which is a
 * different renderer with no chat layout in it, and the session has to outlive
 * every route the user walks through while it runs. A slot rather than a set,
 * the way `watch-session-manager.ts` holds one: a second session would compete
 * for the same microphone and interleave two unrelated timelines.
 *
 * **The microphone has one owner.** A live-voice call is the other thing on
 * this client that opens it, so a toggle that lands while a call is running is
 * refused rather than queued: the call is the session the user is in.
 *
 * **An attempt is a session for the purpose of stopping it.** A start is
 * registered in the slot before it resolves the version gate, so the ordinary
 * stop edge reaches a press the user has changed their mind about. Everything
 * that ends a session ends an attempt the same way and just as synchronously.
 *
 * **A socket is not a session.** The gateway accepts the downstream upgrade
 * before it dials the runtime, so a local `open` proves only that a proxy
 * answered. The runtime's `ready` frame is the first word that a session
 * exists, and it is what starts both the microphone and the `watching` flag
 * the companion draws its capture indicator from. A start that never reaches
 * `ready` is a failed start rather than a session that stopped: it tears down
 * and the flag never moves.
 *
 * **The session belongs to one assistant.** It is started against the active
 * assistant, gated on that assistant being new enough to serve the route, and
 * ended the moment it stops being the active one. The alternative is narration
 * still flowing to the previous assistant's socket while the surface draws the
 * new one's name beside a flag that reads as the new one's.
 *
 * Transport is the dictation stream's, through `buildSelfHostedGatewayWsUrl`:
 * straight to the user's gateway ingress with the actor edge JWT in `?token=`,
 * since browser WebSockets cannot set an `Authorization` header. See
 * `voice/dictation-stream.ts` for the whole rule set, including the local
 * `/assistant/__gateway/<port>` bypass. Off a self-hosted ingress there is no
 * socket to open and the toggle is a no-op.
 */

import { create } from "zustand";

import {
  buildSelfHostedGatewayWsUrl,
  isPairedGatewayIngress,
} from "@/domains/chat/voice/live-voice/connection";
import {
  isLiveVoiceSessionActive,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import {
  LiveVoiceAudioCapture,
  isSupported as isPcmCaptureSupported,
  type LiveVoiceAudioCaptureOptions,
  type LiveVoiceCaptureResult,
} from "@/domains/chat/voice/live-voice/pcm-capture";
import { LIVE_VOICE_AUDIO_FORMAT } from "@/domains/chat/voice/live-voice/protocol";
import { resolveSupportsWatchSessions } from "@/lib/backwards-compat/watch-sessions";
import {
  getSelfHostedActorToken,
  getSelfHostedIngressUrl,
} from "@/lib/self-hosted/connection";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/**
 * Whether a watch session is running, for anything that draws it.
 *
 * A store rather than a plain flag because the companion mirror publishes this
 * to the macOS surface and has to be told when it moves, and because the
 * session is started from outside React entirely. Read it with `getState()`
 * from non-React code, the way the mirror does.
 */
interface WatchState {
  watching: boolean;
}

export const useWatchStore = create<WatchState>(() => ({ watching: false }));

/**
 * How long a session may sit pending before it is given up on.
 *
 * A pending session is one whose socket the gateway accepted without the
 * runtime having answered `ready`. The gateway dials its upstream only after
 * accepting downstream (`gateway/src/http/routes/runtime-audio-stream.ts`), so
 * the local open proves a proxy is listening and nothing more; a runtime that
 * is slow, wedged, or gone leaves the socket open and silent.
 *
 * Generous against a real handshake, which is a loopback or LAN round trip
 * plus resolving a transcriber, and short enough that a user who pressed Watch
 * is not left waiting on an answer that is not coming. The gateway's own
 * pending-frame cap usually closes such a socket first; this is the backstop
 * for a stall that never closes anything.
 */
const READY_TIMEOUT_MS = 10_000;

/** The capture surface this module uses, so tests can stand in for the mic. */
interface WatchCapture {
  start(): Promise<LiveVoiceCaptureResult>;
  shutdown(): void;
  flush?(): void;
}

/** Injection seams for tests. */
export interface WatchControllerOptions {
  webSocketFactory?: (url: string) => WebSocket;
  captureFactory?: (options: LiveVoiceAudioCaptureOptions) => WatchCapture;
  /** Overrides {@link READY_TIMEOUT_MS}, so a test need not wait it out. */
  readyTimeoutMs?: number;
}

/**
 * The running session: the socket, the microphone feeding it, and the teardown
 * that closes both exactly once.
 */
interface WatchSession {
  stop(): void;
}

let session: WatchSession | null = null;

/**
 * Build the watch stream WebSocket URL:
 *
 *   ws(s)://<ingressHost>/v1/watch/stream?token=…&mimeType=audio/pcm&sampleRate=16000
 *
 * The same shape as `buildSttStreamWsUrl`, and through the same helper, so the
 * two audio streams cannot drift into two ideas of how to reach the gateway.
 * Exported for unit tests.
 */
export function buildWatchStreamWsUrl({
  ingressUrl,
  token,
}: {
  ingressUrl: string;
  token: string;
}): string {
  return buildSelfHostedGatewayWsUrl({
    ingressUrl,
    routePath: "/v1/watch/stream",
    token,
    params: {
      mimeType: LIVE_VOICE_AUDIO_FORMAT.mimeType,
      sampleRate: String(LIVE_VOICE_AUDIO_FORMAT.sampleRate),
    },
  });
}

/**
 * Open a session and register it as the running one: the socket first, then
 * the flag and the microphone once the runtime says the session exists.
 *
 * Registers before wiring the socket's listeners so a transport that fails on
 * the spot tears down a session this module already knows about, rather than
 * one that is registered a moment later and can no longer be stopped. It is
 * registered while still pending, which is what keeps the stop edge working
 * before `ready`.
 *
 * Does nothing when this environment has nothing to open: no self-hosted
 * ingress or actor token, no AudioWorklet, a paired gateway whose proxy is
 * HTTP-only. Every one of those is a normal deployment rather than a failure,
 * so the toggle leaves the surface where it was rather than reporting an error
 * the user cannot act on.
 */
function openSession(
  ownerAssistantId: string,
  options: WatchControllerOptions,
): void {
  const ingressUrl = getSelfHostedIngressUrl();
  const token = getSelfHostedActorToken();
  if (!ingressUrl || !token || !isPcmCaptureSupported()) {
    console.info(
      "watch-controller: skipping (no self-hosted ingress/token or no AudioWorklet)",
    );
    return;
  }
  if (isPairedGatewayIngress(ingressUrl)) {
    console.info(
      "watch-controller: skipping (watch sessions aren't available for paired assistants yet)",
    );
    return;
  }

  const webSocketFactory =
    options.webSocketFactory ?? ((url: string) => new WebSocket(url));

  let ws: WebSocket;
  try {
    ws = webSocketFactory(buildWatchStreamWsUrl({ ingressUrl, token }));
  } catch {
    return;
  }

  let closed = false;
  let handle: WatchSession | null = null;
  let unsubscribeAssistant: (() => void) | null = null;
  // Null until the runtime answers `ready`, which is the moment the session
  // exists. Everything before that is a socket.
  let readyTimer: ReturnType<typeof setTimeout> | null = null;

  const capture = (
    options.captureFactory ??
    ((captureOptions: LiveVoiceAudioCaptureOptions) =>
      new LiveVoiceAudioCapture(captureOptions))
  )({
    onChunk: (buf) => {
      if (!closed && ws.readyState === WebSocket.OPEN) {
        ws.send(buf);
      }
    },
  });

  /**
   * Close both halves, exactly once.
   *
   * Reached from the toggle, from the socket ending on its own, and from the
   * layout going away, so it has to be idempotent. The store is written here
   * rather than by the callers, since this is the one place that knows the
   * session is actually over.
   */
  const teardown = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    unsubscribeAssistant?.();
    unsubscribeAssistant = null;
    if (readyTimer !== null) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
    capture.shutdown();
    if (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    ) {
      try {
        ws.close(1000);
      } catch {
        // Already closing, so there is nothing left to close.
      }
    }
    if (session !== null && session === handle) {
      session = null;
      // Only when there is a claim to give up. A session torn down while still
      // pending never made one, and writing the flag anyway would wake every
      // subscriber with a change that did not happen, which on this bridge is
      // an IPC message and a repaint of a floating window.
      if (useWatchStore.getState().watching) {
        useWatchStore.setState({ watching: false });
      }
    }
  };

  handle = {
    stop: () => {
      if (!closed && ws.readyState === WebSocket.OPEN) {
        // The last few milliseconds still sit in the capture's batch
        // accumulator; drain them synchronously before asking the runtime to
        // wrap the session up.
        capture.flush?.();
        try {
          ws.send(JSON.stringify({ type: "stop" }));
        } catch {
          // The socket raced shut, which teardown below already covers.
        }
      }
      teardown();
    },
  };
  // Registered while still pending, so the stop edge works before `ready`:
  // a second press cancels the attempt rather than stranding it. The flag is
  // deliberately not set here.
  session = handle;
  // A gateway that accepts and then never hears from the runtime would
  // otherwise leave the session pending for as long as the page lives.
  readyTimer = setTimeout(() => {
    readyTimer = null;
    console.warn(
      "watch-controller: no ready frame from the runtime, giving up on the session",
    );
    teardown();
  }, options.readyTimeoutMs ?? READY_TIMEOUT_MS);

  /**
   * The session belongs to the assistant it was started for, and ends when
   * that stops being the active one.
   *
   * Switching assistants in Settings leaves this layout mounted and rewrites
   * the active identity and ingress in place, so nothing else would notice: the
   * socket stays open to the previous assistant while the companion draws the
   * new assistant's name beside a `watching` flag that now reads as the new
   * assistant's. The user would believe they are recording for the assistant
   * they just switched to while the narration goes somewhere else, which is
   * worse than a stale indicator.
   *
   * A move to no active assistant counts. It is ambiguous rather than
   * benign, and the safe reading of ambiguity here is to stop capturing; the
   * next press starts a session against whatever is active then.
   */
  unsubscribeAssistant = useResolvedAssistantsStore.subscribe((state) => {
    if (state.activeAssistantId !== ownerAssistantId) {
      console.info(
        "watch-controller: ending the session, its assistant is no longer active",
      );
      teardown();
    }
  });

  /**
   * The runtime accepted the session, which is the first news that one exists.
   *
   * Both the flag and the microphone wait for this rather than for the local
   * open. The flag, because the companion draws a capture indicator from it and
   * the local open proves only that a proxy answered. The microphone, because
   * opening it before the session exists would put the pair the other way
   * round: audio flowing with nothing on screen saying so.
   */
  const onReady = (): void => {
    if (closed) {
      return;
    }
    if (readyTimer !== null) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
    useWatchStore.setState({ watching: true });
    void capture.start().then((result) => {
      // Mic denied, or a device another app is holding. There is nothing to
      // narrate over, so the session ends rather than sitting open on silence.
      if (!result.ok) {
        console.warn("watch-controller: PCM capture failed", result.error);
        teardown();
      }
    });
  };

  ws.addEventListener("message", (event) => {
    if (closed || typeof event.data !== "string") {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      return;
    }
    const message = parsed as { type?: string; message?: string };
    if (message.type === "ready") {
      onReady();
      return;
    }
    if (message.type === "error") {
      console.warn(
        "watch-controller: server error event",
        message.message ?? event.data,
      );
      teardown();
      return;
    }
    if (message.type === "closed") {
      teardown();
    }
  });

  ws.addEventListener("close", teardown);
  ws.addEventListener("error", teardown);
}

/**
 * Turn a watch session on, or off if one is already running.
 *
 * One entry point for both edges, the way the `toggleWatch` command is: the
 * surface draws a single control and this is the side that knows which edge a
 * press is.
 *
 * **Stopping never awaits.** The stop edge is taken before anything
 * asynchronous, so a caller that has to stop a session inside one synchronous
 * stretch can, and so a press cannot be lost to a resolution that outlives the
 * page. Only the start edge resolves anything.
 *
 * A live-voice call refuses the start outright. Both sessions are driven by
 * the one microphone the machine has, and the call is the one the user is
 * already in, so the press is spent rather than queued behind it.
 *
 * An assistant too old to serve `/v1/watch/stream` refuses it too, before any
 * state moves. Without that the press would flip `watching` and then fail the
 * handshake, lighting the surface's capture ring for a session that never
 * existed.
 *
 * Returns a promise so tests can await the start edge. Callers press and walk
 * away; nothing downstream reads the result.
 */
export async function toggleWatch(
  options: WatchControllerOptions = {},
): Promise<void> {
  if (session !== null) {
    session.stop();
    return;
  }
  if (isLiveVoiceSessionActive(useLiveVoiceStore.getState().state)) {
    console.info("watch-controller: refusing to start while a call is running");
    return;
  }
  const assistantId = useResolvedAssistantsStore.getState().activeAssistantId;
  // Nothing to start against, and nothing to bind the session to. The gate
  // below answers `false` for a null owner anyway; taking it here is what lets
  // everything after this line hold a real assistant id.
  if (assistantId === null) {
    console.info("watch-controller: skipping (no assistant is active)");
    return;
  }
  /**
   * The attempt itself, registered as the running session before anything is
   * awaited.
   *
   * The version resolution below can wait seconds on a cold identity fetch,
   * and a press that lands in that window is the user changing their mind. It
   * has to reach something. Registering the attempt is what gives it a `stop`
   * to reach: a second press, a logout, or an unmount all take the ordinary
   * stop edge, synchronously, and the resolution then finds itself cancelled
   * and opens nothing. Without it the press would find no session, do nothing,
   * and the start would go on to open the session the user just cancelled.
   */
  let cancelled = false;
  const attempt: WatchSession = {
    stop: () => {
      cancelled = true;
      if (session === attempt) {
        session = null;
      }
    },
  };
  session = attempt;

  // Resolve the version rather than reading the gate's conservative
  // unknown-is-false, which a press landing before the identity fetch would
  // otherwise hit and refuse an assistant that does support watching. See
  // `docs/BACKWARDS_COMPAT.md` on gated write paths.
  const supported = await resolveSupportsWatchSessions(assistantId);
  if (cancelled) {
    return;
  }
  // Nothing else can have replaced the slot: every other entry point goes
  // through the registered `stop` above, which sets `cancelled`. Released here
  // so `openSession` can register the real session in it.
  session = null;
  if (!supported) {
    console.info(
      "watch-controller: skipping (this assistant has no watch stream to open)",
    );
    return;
  }
  // Re-read across the await. A call can have started, and the active
  // assistant can have moved out from under the gate that just passed.
  if (
    isLiveVoiceSessionActive(useLiveVoiceStore.getState().state) ||
    useResolvedAssistantsStore.getState().activeAssistantId !== assistantId
  ) {
    return;
  }
  openSession(assistantId, options);
}

/**
 * End the session, wherever it is in its life. Idempotent, and a no-op when
 * none is running.
 *
 * Separate from {@link toggleWatch} because teardown is not a press: the
 * layout going away has to end a session rather than start one, and a toggle
 * called at teardown would open the microphone on the way out.
 */
export function stopWatch(): void {
  session?.stop();
}
