/**
 * The live half of a watch session: the user narrates a task while they work,
 * and this decides when to read their screen and what of it to keep.
 *
 * One session at a time, the way `live-voice-session-manager.ts` holds one
 * call. Both are driven by a microphone the machine has exactly one of, and
 * both own a slot rather than a set: a second session would compete for the
 * same audio and interleave two unrelated timelines into one store.
 *
 * The manager owns three decisions the pieces below it deliberately do not
 * make. When to observe, which is a cadence question and belongs to whoever
 * hears the narration. Which observations are worth a stored frame, which
 * `watch-timeline` refuses to infer because the payload it is handed always
 * carries one. And when the session is over, which it answers with a handle
 * rather than by acting: the retrospective is a conversational turn, and a
 * session that ends because the daemon is shutting down has nowhere to run it.
 */

import { randomUUID } from "node:crypto";

import {
  createConversation,
  getConversation,
} from "../persistence/conversation-crud.js";
import {
  type HostObservationFields,
  observeHostScreen,
} from "../runtime/host-observe.js";
import { getLogger } from "../util/logger.js";
import {
  appendNarration,
  appendObservation,
  type WatchAppendResult,
} from "./watch-timeline.js";

const log = getLogger("watch-session-manager");

/**
 * Shortest gap between two observations.
 *
 * Observation is triggered by narration, not by a poll. Speech is the moment
 * the user is saying what they are doing, which is exactly the moment their
 * screen is worth recording. A poll is both wasteful and lossy: most ticks
 * land mid-gesture on a screen nobody described, and the change that matters
 * lands between two of them. The subscription that would make polling
 * unnecessary does not exist either: the mac helper's `cu.perform` is strictly
 * request/response (`HostCuExecutor.swift`), with no channel for the host to
 * push an accessibility change of its own.
 *
 * Every observation costs a full accessibility enumeration plus a JPEG over
 * the wire, so this floor collapses a burst of triggers into one record while
 * staying shorter than any UI step a person pauses to narrate.
 *
 * Measured on real sessions, narration arrives roughly every fifteen seconds
 * rather than every second or two: people narrate in bursts and fall silent
 * while they do the thing they just described. So this floor is rarely the
 * binding constraint, and raising the rate it permits buys nothing. Coverage
 * comes from how many triggers fire, not from how fast they are allowed to —
 * which is what the onset trigger
 * ({@link WatchSessionManager.handleNarrationStart}) and the opening
 * observation in {@link WatchSessionManager.start} are for.
 */
const MIN_OBSERVE_INTERVAL_MS = 5_000;

/**
 * Longest a session goes without an observation.
 *
 * Narration is the trigger, so silent work would otherwise be invisible: the
 * user drags a file, waits on a build, or reads for a minute, and the timeline
 * jumps from what they said before to what they said after with the work
 * itself missing. This is the ceiling on that gap.
 *
 * It is a ceiling and not a poll. The deadline runs from the moment the last
 * observation was dispatched, so the wait a slow read spends counts against the
 * ceiling rather than adding to it. It fires only in a stretch where narration
 * produced none, and a talkative session never reaches it.
 *
 * Sized against how far apart narration actually lands, which measurement puts
 * at roughly fifteen seconds. Matching the two means a silent stretch is
 * covered at about the rate a narrated one is. Set much longer and this stops
 * being a backstop and becomes the dominant trigger, which is worse than it
 * sounds: the gap it leaves falls at the *start* of a session, where the user
 * is opening the thing they are about to demonstrate and the retrospective
 * has no other account of where they began.
 */
const MAX_OBSERVE_INTERVAL_MS = 15_000;

/**
 * How long one observation may take before the session gives up on it.
 *
 * Shorter than {@link MAX_OBSERVE_INTERVAL_MS} so a stalled request cannot
 * outlive the cadence slot it belongs to. `observeHostScreen` defaults to 30s,
 * which is a reasonable wait for a caller with a turn to block on it, and too
 * long for one recording a screen that has since moved on.
 */
const OBSERVE_TIMEOUT_MS = 10_000;

/**
 * The sentence `AXTreeDiff` writes in place of a diff when the window it
 * compared was replaced wholesale rather than edited (`AXTreeDiff.swift`).
 */
const WHOLE_WINDOW_REPLACEMENT_MARKER = "Page navigated";

/**
 * Title carried by a conversation a session mints for itself.
 *
 * Persisted, and read by a person: a session that produces a retrospective
 * surfaces its conversation into the ordinary list, so this is the name of a
 * thread the user goes looking for. It follows the control they pressed.
 *
 * Unlike {@link WATCH_CONVERSATION_SOURCE} below, which is a discriminator
 * nothing displays, so it keeps the word it was frozen with. Existing threads
 * keep the title they were minted with; nothing rewrites them.
 */
const TEACH_CONVERSATION_TITLE = "Teach session";

// FROZEN: persisted `conversations.source` value. Never rename it.
const WATCH_CONVERSATION_SOURCE = "watch";

/**
 * Whether an observation is worth a stored frame.
 *
 * Text first. An accessibility tree describes the screen in a form the
 * retrospective reads directly and costs a fraction of a JPEG to keep. That
 * the payload carries a screenshot is no signal at all: the mac helper
 * captures one on every observe with no opt-out (`HostCuExecutor.swift`), so
 * it is always true. Two shapes make the text thin enough that the pixels
 * become the better record:
 *
 * - No tree. The helper fell back to a bare screenshot because accessibility
 *   enumeration found no focused window, the ordinary result for an app that
 *   exposes nothing. The frame is the only account of that moment there is.
 * - A whole-window replacement. The window the diff was computed against is
 *   gone, so what the user is looking at now is unrelated to anything already
 *   in the timeline.
 */
function shouldAttachScreenshot(observation: HostObservationFields): boolean {
  if (!observation.axTree) {
    return true;
  }
  return observation.axDiff?.includes(WHOLE_WINDOW_REPLACEMENT_MARKER) === true;
}

/** What a finished session leaves behind for the retrospective to read. */
export interface WatchSessionSummary {
  readonly sessionId: string;
  readonly conversationId: string;
  /** Timeline entries the session persisted, narrations and observations. */
  readonly entryCount: number;
  readonly durationMs: number;
}

export interface WatchSessionStartOptions {
  /**
   * Principal id of the actor the session observes on behalf of, the same
   * binding every `HostCuProxy` caller carries. `observeHostScreen` matches
   * the target desktop client against it and fails closed without one.
   */
  readonly sourceActorPrincipalId: string;
  /**
   * Adopt an existing conversation instead of minting one. The row must
   * already exist.
   */
  readonly conversationId?: string;
  /**
   * The desktop client to observe. Required when the actor has more than one
   * connected, because default selection resolves their single `host_cu`
   * client and returns an ambiguity error otherwise.
   */
  readonly clientId?: string;
  /**
   * Called once for each screen read that landed on the timeline, so whoever
   * started the session can tell the user their screen was just read.
   *
   * **It fires on the observation landing, never on the request going out.**
   * A dispatch is a promise, and this session has three ways of breaking one.
   * The host answers `ok: false`, which is every failure it has including a
   * read that outran {@link OBSERVE_TIMEOUT_MS}. The request throws. Or the
   * session ends underneath a read still in flight and the `stopped` guard
   * drops what comes back. An indicator driven from dispatch would draw a
   * capture in all three, which is the one thing a capture indicator may not
   * do. Fired from the single point past every one of those checks, so a
   * failure mode added later is silent here by default rather than loud and
   * wrong.
   *
   * Landing rather than merely returning, for the same reason. A read the
   * store refused (its conversation is gone, or the payload carried nothing)
   * left no record of the screen behind, and there is nothing to confirm.
   *
   * Scoped to the session it was passed with: the manager drops it along with
   * the session on {@link WatchSessionManager.stop}, so a listener cannot
   * outlive what it is reporting on. It owns its own failures; a throw is
   * logged and the session carries on watching.
   */
  readonly onObservation?: () => void;
}

export type WatchSessionStartResult =
  | {
      readonly status: "started";
      readonly sessionId: string;
      readonly conversationId: string;
    }
  | {
      readonly status: "busy";
      readonly sessionId: string;
      readonly conversationId: string;
    }
  | { readonly status: "failed"; readonly reason: string };

export interface WatchSessionManagerOptions {
  /** Reads the screen. Defaults to {@link observeHostScreen}. */
  readonly observe?: typeof observeHostScreen;
  /** Clock the timeline's `atMs` offsets and the rate limit are measured on. */
  readonly now?: () => number;
  readonly createSessionId?: () => string;
}

interface ActiveWatchSession {
  readonly sessionId: string;
  readonly conversationId: string;
  readonly sourceActorPrincipalId: string;
  readonly clientId: string | undefined;
  readonly onObservation: (() => void) | undefined;
  readonly startedAtMs: number;
  entryCount: number;
  /**
   * When the last observation was dispatched, the anchor both the rate limit
   * and the idle ceiling measure from. Negative infinity until the first one,
   * so a session observes on its opening narration rather than spending its
   * first interval blind.
   */
  lastObserveAtMs: number;
  observing: boolean;
  stopped: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export class WatchSessionManager {
  private readonly observe: typeof observeHostScreen;
  private readonly now: () => number;
  private readonly createSessionId: () => string;
  private session: ActiveWatchSession | null = null;

  constructor(options: WatchSessionManagerOptions = {}) {
    this.observe = options.observe ?? observeHostScreen;
    this.now = options.now ?? Date.now;
    this.createSessionId = options.createSessionId ?? randomUUID;
  }

  /**
   * Whether a session is running, optionally for one specific conversation.
   * The toggle that starts and ends a session reads this to know which edge a
   * press is.
   */
  isActive(conversationId?: string): boolean {
    const session = this.session;
    if (session === null) {
      return false;
    }
    return (
      conversationId === undefined || session.conversationId === conversationId
    );
  }

  get activeSessionId(): string | null {
    return this.session?.sessionId ?? null;
  }

  start(options: WatchSessionStartOptions): WatchSessionStartResult {
    const existing = this.session;
    if (existing !== null) {
      return {
        status: "busy",
        sessionId: existing.sessionId,
        conversationId: existing.conversationId,
      };
    }

    // The same fail-closed stance `observeHostScreen` takes, applied before a
    // session exists rather than once per observation: a session without an
    // actor could reach no client and would record nothing but failures.
    if (!options.sourceActorPrincipalId) {
      return {
        status: "failed",
        reason: "A watch session requires the actor principal it observes for.",
      };
    }

    const conversationId = this.resolveConversationId(options.conversationId);
    if (conversationId === null) {
      return {
        status: "failed",
        reason: `Conversation "${options.conversationId}" does not exist.`,
      };
    }

    const session: ActiveWatchSession = {
      sessionId: this.createSessionId(),
      conversationId,
      sourceActorPrincipalId: options.sourceActorPrincipalId,
      clientId: options.clientId,
      onObservation: options.onObservation,
      startedAtMs: this.now(),
      entryCount: 0,
      lastObserveAtMs: Number.NEGATIVE_INFINITY,
      observing: false,
      stopped: false,
      idleTimer: null,
    };
    this.session = session;
    // Read the screen the demonstration begins from, rather than waiting for
    // the first trigger. The opening state is the cheapest context there is
    // and the most expensive to be missing: a demonstration starts with the
    // user already somewhere, and a retrospective that never saw where cannot
    // tell whether the first step was navigating there or working there —
    // it reports the ambiguity instead of the task.
    //
    // Fire and forget, like the idle timer's own dispatch: `observeNow` owns
    // its failures, and a start must not wait on a screen read. It also arms
    // the ceiling on the way out through `scheduleIdleObservation`, which is
    // why nothing arms it here.
    void this.observeNow(session);

    return {
      status: "started",
      sessionId: session.sessionId,
      conversationId,
    };
  }

  /**
   * Observe because the user has started speaking, if the cadence allows it.
   * The entry point the streaming transcript calls on `turn-start`.
   *
   * Speech onset beats the final by however long the sentence takes, and the
   * screen it lands on is the one being described rather than the one after.
   * A person says "now I drag it to the Trash" and then drags it, so the final
   * arrives with the gesture already finished: the state that explains the
   * words is the one that was on screen when they began.
   *
   * Files no entry of its own. There is no text yet at onset, and the final
   * that follows appends the narration; an entry here would be a second,
   * emptier record of one utterance.
   */
  async handleNarrationStart(): Promise<void> {
    const session = this.session;
    if (session === null) {
      return;
    }
    if (this.now() - session.lastObserveAtMs < MIN_OBSERVE_INTERVAL_MS) {
      return;
    }
    await this.observeNow(session);
  }

  /**
   * Record what the user just said and observe the screen if the cadence
   * allows it. The entry point the streaming transcript calls on every final.
   */
  async handleNarrationFinal(text: string): Promise<void> {
    const session = this.session;
    if (session === null) {
      return;
    }

    const nowMs = this.now();
    this.recordAppend(
      session,
      appendNarration(session.sessionId, {
        conversationId: session.conversationId,
        text,
        atMs: nowMs - session.startedAtMs,
      }),
    );

    if (nowMs - session.lastObserveAtMs < MIN_OBSERVE_INTERVAL_MS) {
      return;
    }
    await this.observeNow(session);
  }

  /**
   * End the session and hand back what it recorded.
   *
   * Returns null when nothing is running, so a second stop and a stop that
   * races a client disconnect are both no-ops rather than a second handle for
   * the same session.
   */
  stop(): WatchSessionSummary | null {
    const session = this.session;
    this.session = null;
    if (session === null) {
      return null;
    }

    session.stopped = true;
    this.clearIdleTimer(session);

    return {
      sessionId: session.sessionId,
      conversationId: session.conversationId,
      entryCount: session.entryCount,
      durationMs: Math.max(0, this.now() - session.startedAtMs),
    };
  }

  /**
   * The conversation a session's timeline is keyed on.
   *
   * `background` so the thread stays out of the sidebar while the session
   * runs: nothing is said in it, no turn runs, and its only reader is the
   * retrospective that comes after. A caller-supplied id is adopted only when
   * its row already exists, so a session never mints a conversation under an
   * id it was handed.
   */
  private resolveConversationId(
    conversationId: string | undefined,
  ): string | null {
    if (conversationId !== undefined) {
      return getConversation(conversationId) === null ? null : conversationId;
    }
    return createConversation({
      title: TEACH_CONVERSATION_TITLE,
      conversationType: "background",
      source: WATCH_CONVERSATION_SOURCE,
      origin: "vellum",
    }).id;
  }

  /**
   * Read the screen once and file the result under the moment the request went
   * out.
   *
   * The rate limit and the idle ceiling are both anchored at dispatch rather
   * than at completion, so a slow read neither shortens the gap before the next
   * one nor pushes it out, and a read still in flight turns away the finals
   * that arrive during it.
   */
  private async observeNow(session: ActiveWatchSession): Promise<void> {
    if (session.stopped) {
      return;
    }
    if (session.observing) {
      // The read in flight stands in for this one: it rearms the ceiling
      // against its own dispatch when it settles, which is already due when the
      // read outlasted the interval. The tick is deferred, not dropped.
      return;
    }
    session.observing = true;
    session.lastObserveAtMs = this.now();
    const atMs = session.lastObserveAtMs - session.startedAtMs;

    try {
      const observation = await this.observe({
        sourceActorPrincipalId: session.sourceActorPrincipalId,
        timeoutMs: OBSERVE_TIMEOUT_MS,
        ...(session.clientId ? { clientId: session.clientId } : {}),
      });
      if (session.stopped) {
        return;
      }
      if (!observation.ok) {
        // A session outlives a screen it could not read. The desktop client
        // may be busy, asleep, or briefly disconnected, and the narration
        // still arriving is worth keeping either way.
        log.debug(
          { sessionId: session.sessionId, reason: observation.reason },
          "Watch observation failed",
        );
        return;
      }
      const appended = appendObservation(session.sessionId, {
        conversationId: session.conversationId,
        observation,
        atMs,
        attachScreenshot: shouldAttachScreenshot(observation),
      });
      this.recordAppend(session, appended);
      if (appended.ok) {
        this.announceObservation(session);
      }
    } catch (err) {
      // Nothing on this path is meant to throw, and the idle timer has no
      // caller to hand a rejection to, so an unexpected one ends the
      // observation rather than the process.
      log.warn(
        { err, sessionId: session.sessionId },
        "Watch observation threw",
      );
    } finally {
      session.observing = false;
      this.scheduleIdleObservation(session);
    }
  }

  /**
   * Arm the ceiling on the gap between observations.
   *
   * The deadline is {@link MAX_OBSERVE_INTERVAL_MS} past the last dispatch, so
   * rearming it after a slow read leaves only what remains of that interval and
   * a read that outlasts the interval leaves nothing: the next observation goes
   * out as soon as it settles. Rearmed rather than run as an interval, so it
   * never queues behind itself.
   */
  private scheduleIdleObservation(session: ActiveWatchSession): void {
    this.clearIdleTimer(session);
    if (session.stopped) {
      return;
    }
    // Before the first observation the ceiling runs from the session's start,
    // the last moment its screen was accounted for.
    const anchorMs = Math.max(session.lastObserveAtMs, session.startedAtMs);
    const delayMs = Math.max(
      0,
      anchorMs + MAX_OBSERVE_INTERVAL_MS - this.now(),
    );
    const timer = setTimeout(() => {
      session.idleTimer = null;
      void this.observeNow(session);
    }, delayMs);
    // A watch session is not a reason to hold the process open.
    timer.unref?.();
    session.idleTimer = timer;
  }

  private clearIdleTimer(session: ActiveWatchSession): void {
    if (session.idleTimer !== null) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
  }

  /**
   * Tell the session's listener that a screen read landed.
   *
   * The listener is somebody else's code, so its throw is caught here rather
   * than left to {@link WatchSessionManager.observeNow}'s own catch, which
   * would log it as the observation having failed when the observation is the
   * one thing that provably worked.
   */
  private announceObservation(session: ActiveWatchSession): void {
    if (session.onObservation === undefined) {
      return;
    }
    try {
      session.onObservation();
    } catch (err) {
      log.warn(
        { err, sessionId: session.sessionId },
        "Watch observation listener threw",
      );
    }
  }

  /**
   * Count an append that landed. A refused one is logged and the session
   * carries on: the store turns away an entry whose conversation is gone and
   * one whose observation carried nothing, and neither is a reason to stop
   * watching.
   */
  private recordAppend(
    session: ActiveWatchSession,
    result: WatchAppendResult,
  ): void {
    if (result.ok) {
      session.entryCount += 1;
      return;
    }
    log.debug(
      { sessionId: session.sessionId, reason: result.reason },
      "Watch timeline refused an entry",
    );
  }
}
