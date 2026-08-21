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
 * **The microphone has one owner, in both directions.** A live-voice call is
 * the other thing on this client that opens it. A toggle that lands while a
 * call is running is refused rather than queued, and a call that starts while
 * a session is running or pending ends that session. The call wins because it
 * is interactive where watching is ambient, which is the precedence the
 * companion surface already draws: its `call` phase outranks `watching`.
 *
 * **An attempt is a session for the purpose of stopping it.** A start is
 * registered in the slot before it resolves the version gate, so the ordinary
 * stop edge reaches a press the user has changed their mind about. Everything
 * that ends a session ends an attempt the same way and just as synchronously.
 *
 * **One session at a time, on both sides.** The runtime holds its slot until
 * the provider says `closed`, which is the end of the drain below, so a press
 * that lands during a drain waits for that handoff rather than racing it into
 * a busy refusal the user would experience as nothing happening.
 *
 * **Stopping is two moments, not one.** `{"type":"stop"}` asks the runtime to
 * flush rather than to end: the daemon holds the session in `stopping` so the
 * provider's late finals still reach the timeline, and says `closed` when they
 * have. So a deliberate stop ends everything the user can perceive at once and
 * lets only the socket outlive it, briefly and boundedly. Every other ending
 * closes both together, because none of them owes anyone a flush.
 *
 * **A socket is not a session.** The gateway accepts the downstream upgrade
 * before it dials the runtime, so a local `open` proves only that a proxy
 * answered. The runtime's `ready` frame is the first word that a session
 * exists, and it is what starts both the microphone and the `watching` flag
 * the companion draws its capture indicator from. A start that never reaches
 * `ready` is a failed start rather than a session that stopped: it tears down
 * and the flag never moves.
 *
 * **A capture is the runtime's word, never a local guess.** The runtime
 * decides when to read the screen and reports each read that landed as an
 * `observation` frame; this module counts those frames and nothing else. The
 * cadence is deliberately irregular (it follows the user's narration, between
 * a five second floor and a fifteen second ceiling), so a timer here would
 * claim captures in the gaps and miss the ones that matter, and a count driven
 * from anything the client can see for itself would be a client telling the
 * user what the machine is doing to their screen.
 *
 * **The session belongs to one assistant.** It is started against the active
 * assistant, gated on that assistant being new enough to serve the route, and
 * ended the moment it stops being the active one. The alternative is narration
 * still flowing to the previous assistant's socket while the surface draws the
 * new one's name beside a flag that reads as the new one's.
 *
 * **Transport is live voice's, both halves of it.** `resolveWatchStreamWsUrl`
 * chooses by deployment kind the way `resolveLiveVoiceWsUrl` does: a
 * self-hosted assistant is dialled straight at the user's gateway ingress with
 * the actor edge JWT in `?token=` (browser WebSockets cannot set an
 * `Authorization` header), and a managed one is dialled through velay with a
 * short-lived minted token. See `live-voice/connection.ts` for the whole rule
 * set, including the local `/assistant/__gateway/<port>` bypass.
 *
 * A paired assistant remains the one deployment with no transport at all: its
 * proxy is HTTP-only and there is no loopback to fall back to, so the toggle
 * is a no-op there and says so.
 */

import { create } from "zustand";

import {
  buildSelfHostedGatewayWsUrl,
  buildVelayWsUrl,
  isPairedGatewayIngress,
  mintVelayWsToken,
  PairedVoiceUnavailableError,
  VelayWsTokenError,
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
import { LIVE_VOICE_AUDIO_FORMAT_PARAMS } from "@/domains/chat/voice/live-voice/protocol";
import { beginWatchRetro } from "@/domains/chat/watch/watch-retro";
import { supportsWatchRetroCompletion } from "@/lib/backwards-compat/watch-retro-completion";
import { resolveSupportsWatchSessions } from "@/lib/backwards-compat/watch-sessions";
import {
  getSelfHostedActorToken,
  getSelfHostedIngressUrl,
} from "@/lib/self-hosted/connection";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/**
 * What a watch session looks like from outside: whether one is running, and
 * how much of the user's screen it has read so far.
 *
 * A store rather than a plain flag because the companion mirror publishes this
 * to the macOS surface and has to be told when it moves, and because the
 * session is started from outside React entirely. Read it with `getState()`
 * from non-React code, the way the mirror does.
 */
interface WatchState {
  watching: boolean;
  /**
   * Screen reads this session has taken, one per `observation` frame.
   *
   * The runtime sends that frame only for a read that came back and was kept
   * (`assistant/src/runtime/routes/watch-routes.ts`), so every step of this
   * number is a capture that demonstrably happened. Nothing here counts a
   * dispatch, and nothing here runs on a timer: the runtime's cadence is three
   * or four reads a minute and it moves with what the user does, so a local
   * approximation of it would be a capture indicator that is wrong most of the
   * time in both directions.
   *
   * Zeroed when a session is accepted rather than left to accumulate, so a
   * surface can read "greater than zero" as this session having captured
   * something and never inherit a step from the session before it.
   */
  captureCount: number;
}

export const useWatchStore = create<WatchState>(() => ({
  watching: false,
  captureCount: 0,
}));

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

/**
 * How long the socket may stay open after the user stops, so the runtime can
 * flush what they just said.
 *
 * `{"type":"stop"}` does not end a session on the daemon: it moves it to
 * `stopping` and asks the transcriber to flush, and the provider's late `final`
 * events land on the timeline for as long as that state holds
 * (`assistant/src/runtime/routes/watch-routes.ts`). The session ends when the
 * provider says `closed`, which the daemon relays as its own `closed` frame.
 * Closing the socket the moment stop is sent runs the daemon's close handler
 * instead, which tears the session down and takes the flush with it. A long
 * session loses its last phrase that way and a short one can lose everything
 * the user said.
 *
 * So the socket waits for that frame, and this bounds the wait. A provider
 * flush is well under a second; a socket held open past this is one whose
 * answer is not coming, and a session that will not end is worse than a lost
 * tail.
 */
const STOP_DRAIN_TIMEOUT_MS = 3_000;

type Timer = ReturnType<typeof setTimeout> | null;

/** Cancel a timer if it is armed. Returns the null to assign back to it. */
function cancel(timer: Timer): null {
  if (timer !== null) {
    clearTimeout(timer);
  }
  return null;
}

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
  /**
   * Resolves the socket URL. Defaults to {@link resolveWatchStreamWsUrl}.
   *
   * A seam rather than something a test reaches around, because the alternative
   * is replacing the transport module wholesale with `mock.module`, and that
   * replacement outlives the file that asked for it: bun shares one process
   * across test files, so the next file to import the real module gets the
   * stand-in instead. The three seams above exist for the same reason, and
   * this one covers the only remaining dependency a session start has.
   */
  resolveWsUrl?: (assistantId: string) => Promise<string>;
  /** Overrides {@link READY_TIMEOUT_MS}, so a test need not wait it out. */
  readyTimeoutMs?: number;
  /** Overrides {@link STOP_DRAIN_TIMEOUT_MS}, for the same reason. */
  drainTimeoutMs?: number;
}

/**
 * The running session, from the outside: one way to end it.
 *
 * What that costs is not symmetric. Everything the user can perceive ends
 * synchronously, and the socket may outlive the call briefly while the runtime
 * flushes. See the stop edge in `openSession`.
 */
interface WatchSession {
  stop(): void;
}

let session: WatchSession | null = null;

/**
 * Whether {@link toggleWatch} would take its stop edge if it were called now.
 *
 * The same slot that edge reads, exposed so a caller that gates the start can
 * gate only the start. Anything that answers this question from elsewhere would
 * be answering a different one: {@link useWatchStore} turns true when a session
 * opens, and a start that is registered but still resolving its version gate is
 * already stoppable while that store still says no.
 *
 * Synchronous and unsubscribed on purpose. It is worth reading only in the
 * instant before a toggle, and nothing that draws should read it: what to draw
 * is {@link useWatchStore}.
 */
export function isWatchSessionActive(): boolean {
  return session !== null;
}

/**
 * Resolves when a session that is still draining has let go of the runtime's
 * slot, or `null` when none is.
 *
 * The runtime holds one watch session at a time and keeps its slot until the
 * provider says `closed`, which is the same moment the drain here ends. A
 * start that raced ahead of that would be refused as busy by
 * `WatchSessionManager.start`, and the user would have pressed Watch and got
 * nothing, with nothing to explain it. So a start waits for the handoff rather
 * than being refused, which puts the wait somewhere the user can still cancel
 * instead of putting the silence somewhere else.
 */
let drainRelease: Promise<void> | null = null;

/** The route both transports open, on the gateway either way. */
const WATCH_STREAM_ROUTE = "/v1/watch/stream";

/**
 * Build the self-hosted watch stream WebSocket URL:
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
    routePath: WATCH_STREAM_ROUTE,
    token,
    params: LIVE_VOICE_AUDIO_FORMAT_PARAMS,
  });
}

/**
 * Resolve the watch stream WebSocket URL for `assistantId`, choosing the
 * transport by deployment kind exactly as {@link resolveLiveVoiceWsUrl} does.
 *
 * - **Self-hosted / local** — dial the user's own gateway ingress with the
 *   actor edge JWT. No token is minted; the gateway validates the JWT and
 *   checks its principal against the guardian binding.
 * - **Managed / cloud** — mint a short-lived velay token and dial velay, which
 *   validates and consumes it, then injects the authenticated user and org as
 *   `X-Velay-*` headers. The gateway takes its managed branch on those and
 *   cross-checks the caller against the stored `platform_user_id`
 *   (`gateway/src/http/routes/guardian-pin.ts`), so the guardian-only rule is
 *   the same rule on both paths, proven two different ways.
 *
 * Throws rather than returning null, so a start that cannot resolve a URL is
 * distinguishable from one this environment simply does not support:
 *
 * - {@link PairedVoiceUnavailableError} for a paired ingress, whose proxy is
 *   HTTP-only with no loopback to fall back to. Still genuinely unsupported.
 * - {@link VelayWsTokenError} when the ingress is known but its actor token
 *   has not been provisioned yet (a brief post-hatch window), and for a mint
 *   that the platform refuses.
 *
 * Exported for unit tests.
 */
export async function resolveWatchStreamWsUrl(
  assistantId: string,
): Promise<string> {
  const ingressUrl = getSelfHostedIngressUrl();
  if (ingressUrl) {
    if (isPairedGatewayIngress(ingressUrl)) {
      throw new PairedVoiceUnavailableError();
    }
    const token = getSelfHostedActorToken();
    if (!token) {
      throw new VelayWsTokenError(
        0,
        "Self-hosted watch has no actor token yet; the gateway isn't ready.",
      );
    }
    return buildWatchStreamWsUrl({ ingressUrl, token });
  }

  const { token } = await mintVelayWsToken(assistantId);
  return buildVelayWsUrl({
    assistantId,
    routePath: WATCH_STREAM_ROUTE,
    token,
    params: LIVE_VOICE_AUDIO_FORMAT_PARAMS,
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
 * Takes an already-resolved `wsUrl` and stays synchronous, which is the point:
 * resolving it is a network call on the managed path, and everything this
 * function does after the first line has to happen in one uninterrupted
 * stretch for the registration order above to mean anything. The await lives
 * in {@link toggleWatch}, where a press that lands during it is already
 * cancellable.
 *
 * Does nothing when this environment has no AudioWorklet, which is a normal
 * browser rather than a failure, so the toggle leaves the surface where it was
 * rather than reporting an error the user cannot act on.
 */
function openSession(
  ownerAssistantId: string,
  wsUrl: string,
  options: WatchControllerOptions,
): void {
  if (!isPcmCaptureSupported()) {
    console.info("watch-controller: skipping (no AudioWorklet)");
    return;
  }

  const webSocketFactory =
    options.webSocketFactory ?? ((url: string) => new WebSocket(url));

  let ws: WebSocket;
  try {
    ws = webSocketFactory(wsUrl);
  } catch {
    return;
  }

  /**
   * `live` while the session is the user's, `draining` while only the socket
   * is still finishing, `done` when there is nothing left.
   *
   * Three states rather than a boolean because a deliberate stop splits into
   * two moments. Everything the user can perceive ends at once, and the socket
   * outlives it just long enough for the runtime to flush what they said.
   */
  let phase: "live" | "draining" | "done" = "live";
  // False until the runtime answers `ready`. A session that never got that far
  // has captured nothing and holds nothing on the runtime, which is what
  // decides whether stopping owes a flush.
  let accepted = false;
  /**
   * The ids the runtime named its session by, or null when it named none.
   *
   * Separate from {@link accepted} rather than standing in for it, because they
   * answer different questions. Acceptance is whether a session exists, and the
   * flush and the slot both turn on that. These ids are only how the summary
   * that session leaves behind is recognised when the runtime announces it, so
   * a `ready` that arrives without them still opens the microphone and only
   * costs the prompt at the end.
   */
  let runtimeSession: { sessionId: string; conversationId: string } | null =
    null;
  // Set while this session is the one holding {@link drainRelease}, so the
  // next start can be let through once the runtime has let go.
  let releaseDrain: (() => void) | null = null;
  let handoffTimer: Timer = null;
  let handle: WatchSession | null = null;
  /**
   * Store subscriptions that live exactly as long as this session does.
   *
   * One list rather than a named handle each, because teardown treats them
   * identically and the next one is then free. A leaked subscription is
   * invisible in behavior, since teardown is idempotent, so nothing would
   * point at a handle that got added here and not released below.
   */
  const subscriptions: (() => void)[] = [];
  // Null until the runtime answers `ready`, which is the moment the session
  // exists. Everything before that is a socket.
  let readyTimer: Timer = null;
  // Set only while the socket is draining after a deliberate stop.
  let drainTimer: Timer = null;

  const capture = (
    options.captureFactory ??
    ((captureOptions: LiveVoiceAudioCaptureOptions) =>
      new LiveVoiceAudioCapture(captureOptions))
  )({
    onChunk: (buf) => {
      if (phase === "live" && ws.readyState === WebSocket.OPEN) {
        ws.send(buf);
      }
    },
  });

  /**
   * Give up everything the user can perceive: the microphone, the flag the
   * capture indicator is drawn from, and this module's claim on the session
   * slot. Exactly once.
   *
   * Split out from closing the socket because the two do not always happen
   * together. On a deliberate stop this runs immediately and the socket stays
   * open a moment longer to let the runtime flush; every other ending does
   * both at once. Callers that stop a session inside one synchronous stretch,
   * such as the hard-logout path, depend on this half taking effect before
   * they return.
   */
  let released = false;
  const releaseLocally = (): void => {
    if (released) {
      return;
    }
    released = true;
    for (const unsubscribe of subscriptions.splice(0)) {
      unsubscribe();
    }
    readyTimer = cancel(readyTimer);
    capture.shutdown();
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

  /**
   * End the session for good: release the local half if it is still held, and
   * close the socket. Idempotent.
   *
   * Every ending that is not the user's own stop lands here directly, and the
   * user's stop lands here once the runtime has answered or the drain has run
   * out of patience. None of those endings owes anyone a flush: a socket that
   * dropped, a call taking the microphone, a window being destroyed, and a
   * runtime reporting an error are all already over.
   */
  const finish = (): void => {
    if (phase === "done") {
      return;
    }
    phase = "done";
    drainTimer = cancel(drainTimer);
    releaseLocally();
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
  };

  /**
   * Hold the next start back until the runtime has let go of its session slot.
   *
   * Taken whenever the runtime *may* hold it, which starts earlier than
   * `ready`: `WatchStreamSession.start()` claims the manager before it sends
   * that frame, so a session stopped in between still has a runtime session
   * behind it. Releasing the claim there let a restart open a socket the
   * runtime then refused as busy, which the user experienced as pressing Watch
   * and nothing happening.
   */
  const claimHandoff = (): void => {
    if (releaseDrain !== null) {
      return;
    }
    drainRelease = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    // **Two honest signals, and this socket closing is not one of them.**
    //
    // The runtime's `closed` frame is one: it is sent after `manager.stop()`,
    // so it is the runtime saying the slot is free. The timer below is the
    // other, as a bound rather than as evidence.
    //
    // A downstream close is not, because there is a proxy in between. The
    // gateway's close handler calls `upstream.close()` and returns
    // (`runtime-audio-stream.ts`); it waits for neither the upstream handshake
    // nor the runtime's `handleClose`. So this socket reporting closed says
    // the browser and the gateway are done, and says nothing about whether the
    // runtime has released anything.
    //
    // A session stopped before `ready` therefore has only the timer: it is
    // closed without a stop frame, so no `closed` frame is coming. That makes
    // a restart straight after such a stop wait out the bound. Deliberate, and
    // the smaller cost: the alternative is a restart that reaches a runtime
    // still holding its slot and is refused, which the user reads as the
    // button not working.
    handoffTimer = setTimeout(
      releaseHandoff,
      options.drainTimeoutMs ?? STOP_DRAIN_TIMEOUT_MS,
    );
  };

  /** The runtime has let go, or has run out of time to. Idempotent. */
  function releaseHandoff(): void {
    handoffTimer = cancel(handoffTimer);
    if (releaseDrain === null) {
      return;
    }
    const release = releaseDrain;
    releaseDrain = null;
    drainRelease = null;
    release();
  }

  handle = {
    /**
     * The user is done narrating.
     *
     * **Two halves, and only one of them waits.** Everything the user can
     * perceive ends now: the flag goes down, the microphone closes, the
     * subscriptions go, and the slot is free for the next press. What waits is
     * the socket, because `{"type":"stop"}` asks the runtime to flush rather
     * than to end, and the last thing the user said is still inside the
     * provider when the frame goes out. See {@link STOP_DRAIN_TIMEOUT_MS}.
     */
    stop: () => {
      if (phase !== "live") {
        return;
      }

      // **Two different questions, and they have different answers here.**
      //
      // Whether the socket owes a flush is `accepted`: before `ready` the
      // runtime is still `initializing`, where its `handleStop` ignores the
      // frame outright, so draining would buy nothing and cost the full wait.
      //
      // Whether the runtime may still hold its session slot starts earlier
      // than that. `WatchStreamSession.start()` claims the manager before it
      // sends `ready`, so a session stopped in between has a runtime session
      // behind it that a restart would collide with. The claim goes on the
      // socket being open, and only the flush goes on `accepted`.
      const socketOpen = ws.readyState === WebSocket.OPEN;
      if (socketOpen) {
        claimHandoff();
      }

      // **The summary starts waiting here, not when the socket closes.** A
      // session the runtime accepted is one it will write a retrospective for,
      // and the wait is the user's: they pressed stop and the surface owes them
      // an answer from that press onward, not from whenever the flush happens
      // to finish. Only a deliberate stop, because every other ending is
      // something going wrong rather than the user asking for a summary.
      //
      // Gated separately from watching itself. An assistant can be new enough
      // to serve the stream and still predate the announcement that ends the
      // wait, and opening a wait against one of those leaves the surface
      // expanded on "Summarizing" until the three-minute give-up timer, after
      // every session. See `backwards-compat/watch-retro-completion.ts`.
      if (
        runtimeSession !== null &&
        supportsWatchRetroCompletion(ownerAssistantId)
      ) {
        beginWatchRetro({ ...runtimeSession, assistantId: ownerAssistantId });
      }

      let draining = false;
      if (accepted && socketOpen) {
        // The last few milliseconds still sit in the capture's batch
        // accumulator; drain them synchronously so they go out ahead of the
        // stop frame.
        capture.flush?.();
        try {
          ws.send(JSON.stringify({ type: "stop" }));
          draining = true;
        } catch {
          // The socket raced shut, so there is nothing to flush and nothing to
          // wait for.
        }
      }

      // Before the wait, never after it. Callers that stop inside one
      // synchronous stretch, and the surface that must stop drawing a capture
      // the moment it is asked to, both depend on this having happened by the
      // time this call returns.
      releaseLocally();

      if (!draining) {
        finish();
        return;
      }
      phase = "draining";
      drainTimer = setTimeout(() => {
        console.warn(
          "watch-controller: no closed frame after stop, ending without the flush",
        );
        finish();
      }, options.drainTimeoutMs ?? STOP_DRAIN_TIMEOUT_MS);
    },
  };
  // Registered while still pending, so the stop edge works before `ready`:
  // a second press cancels the attempt rather than stranding it. The flag is
  // deliberately not set here.
  session = handle;
  // A gateway that accepts and then never hears from the runtime would
  // otherwise leave the session pending for as long as the page lives.
  readyTimer = setTimeout(() => {
    console.warn(
      "watch-controller: no ready frame from the runtime, giving up on the session",
    );
    finish();
  }, options.readyTimeoutMs ?? READY_TIMEOUT_MS);

  /**
   * A call takes the microphone, and this session gives it up.
   *
   * The refusal in `toggleWatch` covers one direction only: Watch pressed
   * during a call. The other direction has its own doors, and they do not
   * consult this module. The companion surface's Talk and the composer's voice
   * button both start a session without asking whether one is watching, and
   * two controllers holding the same microphone stream the same audio into two
   * unrelated sessions.
   *
   * Ending here rather than teaching every live-voice entry point to refuse,
   * for two reasons. A call is interactive and immediate where a watch session
   * is ambient, so the call is the one that should win. And the surface already
   * says so: its `call` phase outranks `watching`, so this is the controller
   * agreeing with what the user is already being shown, rather than a rule
   * that has to be repeated at each new door somebody adds.
   */
  subscriptions.push(
    useLiveVoiceStore.subscribe((state) => {
      if (isLiveVoiceSessionActive(state.state)) {
        console.info(
          "watch-controller: ending the session, a call has taken the microphone",
        );
        finish();
      }
    }),
  );

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
  subscriptions.push(
    useResolvedAssistantsStore.subscribe((state) => {
      if (state.activeAssistantId !== ownerAssistantId) {
        console.info(
          "watch-controller: ending the session, its assistant is no longer active",
        );
        finish();
      }
    }),
  );

  /**
   * The runtime accepted the session, which is the first news that one exists.
   *
   * Both the flag and the microphone wait for this rather than for the local
   * open. The flag, because the companion draws a capture indicator from it and
   * the local open proves only that a proxy answered. The microphone, because
   * opening it before the session exists would put the pair the other way
   * round: audio flowing with nothing on screen saying so.
   */
  const onReady = (
    session: { sessionId: string; conversationId: string } | null,
  ): void => {
    accepted = true;
    runtimeSession = session;
    readyTimer = cancel(readyTimer);
    // The capture count belongs to this session and starts at none, in the
    // same write as the flag: a surface that read a leftover count beside a
    // freshly true flag would mark a capture this session has not taken.
    useWatchStore.setState({ watching: true, captureCount: 0 });
    void capture.start().then((result) => {
      // Mic denied, or a device another app is holding. There is nothing to
      // narrate over, so the session ends rather than sitting open on silence.
      if (!result.ok) {
        console.warn("watch-controller: PCM capture failed", result.error);
        finish();
      }
    });
  };

  ws.addEventListener("message", (event) => {
    // Frames still matter while draining: the `closed` one is exactly what the
    // drain is waiting for.
    if (phase === "done" || typeof event.data !== "string") {
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
    const message = parsed as {
      type?: string;
      message?: string;
      sessionId?: string;
      conversationId?: string;
    };
    if (message.type === "ready") {
      // Only ever meaningful on a live session. A `ready` arriving while the
      // socket drains would be reopening a microphone the user just closed.
      if (phase === "live") {
        onReady(
          // The ids the runtime names its session by. A frame missing either
          // still starts the session: recording is what the user pressed for,
          // and the cost of the gap is a summary this window cannot match to an
          // announcement, which is smaller than a microphone that never opened.
          typeof message.sessionId === "string" &&
            typeof message.conversationId === "string"
            ? {
                sessionId: message.sessionId,
                conversationId: message.conversationId,
              }
            : null,
        );
      }
      return;
    }
    if (message.type === "observation") {
      // The runtime read the screen and kept what it saw. Counted only on a
      // live session: past the stop edge the flag is already down and the
      // surface has stopped drawing a capture, so a late read from the flush
      // has nothing left to mark.
      if (phase === "live") {
        useWatchStore.setState((state) => ({
          captureCount: state.captureCount + 1,
        }));
      }
      return;
    }
    if (message.type === "error") {
      console.warn(
        "watch-controller: server error event",
        message.message ?? event.data,
      );
      finish();
      return;
    }
    if (message.type === "closed") {
      // The runtime is done, which on the drain path means the flush landed.
      // It sends this frame after releasing its session slot, so it is also
      // the earliest honest moment to let a waiting start through.
      releaseHandoff();
      finish();
    }
  });

  // The socket is gone, so the session is over. Deliberately does not release
  // the handoff: see `claimHandoff` for why a downstream close is not evidence
  // that the runtime has let go of its session slot.
  ws.addEventListener("close", finish);
  ws.addEventListener("error", finish);
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

  /**
   * Give up the slot without cancelling, for a start that ends on its own
   * terms rather than by a press: an unsupported assistant, a transport that
   * will not resolve, a re-read that no longer holds. Also how the slot is
   * handed to `openSession` on the way through.
   *
   * Guarded on identity rather than assigning null outright, so a start that
   * lost the slot to a newer one cannot clear the newer one's registration.
   */
  const releaseAttempt = (): void => {
    if (session === attempt) {
      session = null;
    }
  };

  // Resolve the version rather than reading the gate's conservative
  // unknown-is-false, which a press landing before the identity fetch would
  // otherwise hit and refuse an assistant that does support watching. See
  // `docs/BACKWARDS_COMPAT.md` on gated write paths.
  const supported = await resolveSupportsWatchSessions(assistantId);
  if (cancelled) {
    return;
  }
  // A previous session may still be draining, and the runtime holds its one
  // slot until that finishes. Starting now would race it and be refused as
  // busy, which the user would experience as pressing Watch and nothing
  // happening. Waiting is bounded by the drain's own timer, and the attempt
  // stays registered across it, so the press remains cancellable throughout.
  if (drainRelease !== null) {
    console.info(
      "watch-controller: waiting for the previous session to release the runtime",
    );
    await drainRelease;
    if (cancelled) {
      return;
    }
  }
  if (!supported) {
    releaseAttempt();
    console.info(
      "watch-controller: skipping (this assistant has no watch stream to open)",
    );
    return;
  }
  /**
   * The transport, resolved last and while the attempt still holds the slot.
   *
   * On a managed assistant this mints a single-use velay token, which is a
   * round trip to the platform and the one genuinely new wait on this path.
   * It is deliberately the last thing before the dial: the token lives 60
   * seconds, and resolving it ahead of the drain wait above would spend part
   * of that life waiting on the previous session.
   *
   * A throw here is not the same as an unsupported environment — a paired
   * ingress, an unprovisioned actor token, a refused mint — but the press has
   * nowhere to go in any of those cases, so all of them leave the surface
   * where it was and say why in the log.
   */
  let wsUrl: string;
  try {
    wsUrl = await (options.resolveWsUrl ?? resolveWatchStreamWsUrl)(
      assistantId,
    );
  } catch (err) {
    releaseAttempt();
    console.info("watch-controller: skipping (no watch transport)", err);
    return;
  }
  if (cancelled) {
    return;
  }
  // Re-read across the awaits. A call can have started, and the active
  // assistant can have moved out from under the gate that just passed. Taken
  // after the transport resolves rather than before, so the check that decides
  // is the one nearest the dial; the cost is a minted token spent on a start
  // that is then discarded, and a single-use token nobody presents just
  // expires.
  if (
    isLiveVoiceSessionActive(useLiveVoiceStore.getState().state) ||
    useResolvedAssistantsStore.getState().activeAssistantId !== assistantId
  ) {
    releaseAttempt();
    return;
  }
  // Nothing else can have replaced the slot: every other entry point goes
  // through the registered `stop` above, which sets `cancelled`. Released here
  // so `openSession` can register the real session in it.
  releaseAttempt();
  openSession(assistantId, wsUrl, options);
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
