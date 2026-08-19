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
 * True while a start is between the version resolution and the socket.
 *
 * The start path awaits, so without this a second press arriving inside that
 * window would find no session yet and open a second one. A press that lands
 * there is dropped rather than queued: the window is a microtask on a warm
 * app, and dropping is the edge that cannot leave two microphones open.
 */
let starting = false;

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
 * the microphone once it is up.
 *
 * Registers before wiring the socket's listeners so a transport that fails on
 * the spot tears down a session this module already knows about, rather than
 * one that is registered a moment later and can no longer be stopped.
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
      useWatchStore.setState({ watching: false });
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
  session = handle;
  useWatchStore.setState({ watching: true });

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

  ws.addEventListener("open", () => {
    if (closed) {
      return;
    }
    void capture.start().then((result) => {
      // Mic denied, or a device another app is holding. There is nothing to
      // narrate over, so the session ends rather than sitting open on silence.
      if (!result.ok) {
        console.warn("watch-controller: PCM capture failed", result.error);
        teardown();
      }
    });
  });

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
  if (starting) {
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
  starting = true;
  try {
    // Resolve the version rather than reading the gate's conservative
    // unknown-is-false, which a press landing before the identity fetch would
    // otherwise hit and refuse an assistant that does support watching. See
    // `docs/BACKWARDS_COMPAT.md` on gated write paths.
    if (!(await resolveSupportsWatchSessions(assistantId))) {
      console.info(
        "watch-controller: skipping (this assistant has no watch stream to open)",
      );
      return;
    }
    // Re-read across the await. A call can have started and the session can
    // have been opened and stopped by another press in the meantime, and the
    // active assistant can have moved out from under the gate that just
    // passed.
    if (
      session !== null ||
      isLiveVoiceSessionActive(useLiveVoiceStore.getState().state) ||
      useResolvedAssistantsStore.getState().activeAssistantId !== assistantId
    ) {
      return;
    }
    openSession(assistantId, options);
  } finally {
    starting = false;
  }
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
