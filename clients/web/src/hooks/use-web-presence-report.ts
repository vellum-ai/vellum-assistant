/**
 * Reports client visibility and focused-conversation state to the daemon, so
 * a `chat.assistant_reply` APNs push can be suppressed when the reply's own
 * conversation is already open and visible here (see
 * `assistant/src/runtime/web-presence.ts`).
 *
 * Runs in a browser tab and in the Electron desktop renderer alike. Both
 * register as interface `"web"` with their own client id
 * (`lib/telemetry/client-identity.ts` hardcodes it on purpose), and the
 * daemon consults the gate this feeds for every reply whatever device sent
 * the turn: `assistant/src/notifications/assistant-reply-producer.ts` calls
 * `isWebConversationFocused` unconditionally, and only the desktop read
 * beside it is `clientOs`-gated. Reporting from the desktop is therefore what
 * suppresses a push to a window already showing the conversation when the
 * turn was sent from the phone. Desktop host-proxy attendance answers a
 * different question, whether the user is at that computer at all, so never
 * reuse that path for this.
 *
 * `isVisibleToUser()` from `runtime/window-attention.ts` answers "is this
 * client on screen" on every platform, and `use-notification-intent-sync`
 * asks it the same way. Under Electron the answer comes from the main
 * process rather than the DOM: Vellum windows disable background throttling,
 * which disables the Page Visibility API with it, so
 * `document.visibilityState` is pinned to `"visible"` in that renderer and
 * reading it would report a minimized window as watched. That read requires
 * focus as well as being on screen, because main can see both. A browser tab
 * keeps visibility-only semantics: `document.hasFocus()` is window-level and
 * can be false for a visible tab in an unfocused browser window, while
 * visibility is the existing contract for whether the conversation is on
 * screen.
 *
 * Every desktop window reports for itself, and a conversation pop-out is a
 * separate page load, so it is its own `"web"` client with its own report.
 * `isWebConversationFocused` matches with `.some(...)`, so a pop-out left
 * attended on a conversation suppresses that conversation's pushes while the
 * main window sits minimized behind it. That is intended.
 *
 * Reports on mount, on every visibility edge (via the bus's `app.resume` /
 * `app.hidden`, not a raw `visibilitychange` listener, see
 * `docs/EVENT_BUS.md`), on every desktop attention edge (`app.attention`),
 * on the desktop's screen-lock and system-suspend edges (`power.lock` /
 * `power.suspend`, and again on `power.unlock` / `power.resume`), whenever the
 * focused conversation changes (route or active-conversation-id change), and
 * on a periodic reconciliation tick while visible. Each report reads
 * visibility at post time rather than trusting cached lifecycle state.
 * "Focused" counts the active conversation id only while the chat route for
 * it is on screen, since `activeConversationId` is never cleared on
 * navigation away.
 *
 * Visibility is necessary but not sufficient: a tab left on a second monitor
 * reports `visible` forever, so a client with no user input for
 * `IDLE_THRESHOLD_MS` stops counting and its report ages out of the daemon's
 * TTL, restoring the push. This mirrors the desktop reporter, which derives
 * attendance from system idle time for the same reason. A desktop window that
 * loses focus without leaving the screen does not wait out that aging: losing
 * focus is not a lifecycle edge, since `app.hidden` means backgrounded to the
 * consumers that give the camera hardware back, so that case reports off
 * `app.attention` instead.
 *
 * A locked screen is the one state neither of those catches: the window stays
 * visible, focused and unminimized behind the lock, and the idle clock only
 * expires ten minutes after the last keystroke. `power.lock` and
 * `power.suspend` latch this client as away and report `visible: false` at
 * once, so the reply goes to the phone the user just walked away with. The
 * latch is what makes that last. A one-shot report would be undone by the next
 * reconciliation tick, which asks the window where it is and hears "visible,
 * focused, unminimized" from behind the lock screen. The two latch separately
 * and clear on their own edge, `power.unlock` and `power.resume`: see
 * {@link screenLocked} and {@link systemSuspended}.
 *
 * A latch only covers a lock this renderer watched happen, and a renderer that
 * mounts behind one has nothing to ask. Mount is therefore not input under
 * Electron, which also launches at login and reloads after a crash with nobody
 * arriving. The desktop idle clock starts on the first real interaction, and
 * short of one this client reports away. A browser tab mounts from a
 * navigation the user performed, so its mount is input.
 *
 * The reconciliation tick exists because the daemon's presence gate is
 * TTL-bound (`WEB_PRESENCE_STALE_AFTER_MS` in
 * `assistant/src/runtime/web-presence.ts`): without a re-report, a tab left
 * open and focused on one conversation would eventually go stale. It is slow
 * by design because the SSE heartbeat separately proves transport liveness;
 * the semantic report still needs periodic refresh while visible.
 *
 * Fire-and-forget and best-effort cleanup: the daemon's presence gate fails
 * open on a missing/stale report, so a dropped call (network blip, tab
 * killed before a final report lands) just forgoes suppression for the
 * remainder of the TTL. It never blocks the UI or breaks chat.
 *
 * Reports are serialized rather than raced. See {@link reportWebPresence}.
 */
import { useEffect, useRef } from "react";
import { useLocation } from "react-router";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useSupportsWebPresence } from "@/lib/backwards-compat/use-supports-web-presence";
import { isElectron } from "@/runtime/is-electron";
import { isVisibleToUser } from "@/runtime/window-attention";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useConversationStore } from "@/stores/conversation-store";
import { isConversationChatPath } from "@/utils/routes";

interface WebPresenceReportBody {
  visible: boolean;
  focusedConversationId: string | null;
}

/** See the module doc comment for the sizing rationale. */
const RECONCILIATION_INTERVAL_MS = 60_000;

/**
 * How long without user input before a visible tab stops counting as
 * presence. Matches `IDLE_THRESHOLD_MS` in `clients/macos/src/main/presence.ts`
 * so both surfaces wait out the same amount of plain inactivity.
 */
const IDLE_THRESHOLD_MS = 10 * 60_000;

/**
 * Input events that count as the user still being at this tab. Passive and
 * capture-phase, so a scroll inside the transcript counts too and nothing
 * here can delay the event it observes.
 */
const INTERACTION_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "wheel",
  "touchstart",
] as const;

/** Whether the user touched this client inside {@link IDLE_THRESHOLD_MS}. */
function hasRecentInput(lastInteractionAt: number): boolean {
  return Date.now() - lastInteractionAt <= IDLE_THRESHOLD_MS;
}

/**
 * Whether the desktop screen is locked, latched until an unlock edge clears it.
 *
 * Module scope because it describes the machine this renderer runs on rather
 * than any one mount, and because a lock outlives whatever component tree
 * happens to be up. Off Electron it is never set: `power.lock` has one
 * publisher, `runtime/event-sources/electron-power.ts`, and the runtime
 * wrapper under it no-ops in a browser and in the Capacitor shell.
 *
 * `power.resume` deliberately leaves this alone. A machine that wakes from
 * sleep on macOS or Windows wakes to its lock screen, so clearing here on a
 * wake would hand the reconciliation tick back the "visible" answer the latch
 * exists to override, and suppression would resume for the rest of the idle
 * window with nobody at the machine. A latch left set by a missed unlock errs
 * the safe way instead: this client reports away, the daemon suppresses
 * nothing, and the push reaches the phone.
 */
let screenLocked = false;

/**
 * Whether the machine is suspended, latched until it wakes.
 *
 * Tracked apart from {@link screenLocked} because the two edges clear on
 * different signals. Electron only emits `unlock-screen` on macOS and Windows,
 * so a single flag set by both `power.lock` and `power.suspend` and cleared by
 * `power.unlock` alone would latch a Linux desktop away on its first system
 * sleep and report `visible: false` for the life of the renderer, sending a
 * redundant push to the phone for every reply after it. `power.resume` clears
 * this one, and a machine that woke to a lock screen stays away on the other.
 */
let systemSuspended = false;

/**
 * Whether the user is away from the machine this renderer runs on, because the
 * screen is locked, the machine is suspended, or both.
 *
 * Every presence read has to consult this, because none of the underlying
 * signals can see a lock screen: the window behind one still reports visible,
 * focused and unminimized, and the SSE heartbeat keeps proving the transport is
 * fine.
 */
function isMachineAway(): boolean {
  return screenLocked || systemSuspended;
}

/**
 * Whether this client currently counts as presence: the user at the machine,
 * this client on screen, and the user having touched it inside
 * {@link IDLE_THRESHOLD_MS}.
 */
function isPresent(lastInteractionAt: number): boolean {
  return (
    !isMachineAway() && isVisibleToUser() && hasRecentInput(lastInteractionAt)
  );
}

/**
 * Assistant builds that answered 404, which is what a daemon without the
 * route says. {@link useSupportsWebPresence} normally keeps reports off those
 * builds, but its floor orders dev builds by timestamp alone, so a build cut
 * from `main` before the route landed clears it. One 404 settles the question
 * and reporting stops rather than repeating on every edge, SSE open, and tick.
 *
 * Keyed by assistant and version, which is the only thing that can turn a
 * route-less daemon into one that answers. An SSE reopen cannot: `sse-service`
 * publishes it for ordinary transport recovery too, so clearing on reopen
 * would hand back a 404 per reconnect. Keying rather than latching one slot
 * also keeps a switch between two assistants from re-probing either one.
 */
const routeMissingBuilds = new Set<string>();

async function postWebPresence(
  assistantId: string,
  buildKey: string,
  body: WebPresenceReportBody,
): Promise<void> {
  if (routeMissingBuilds.has(buildKey)) {
    return;
  }
  try {
    const { response } = await daemonClient.post({
      url: "/v1/assistants/{assistant_id}/clients/web-presence",
      path: { assistant_id: assistantId },
      body,
      throwOnError: false,
    });
    if (response?.status === 404) {
      routeMissingBuilds.add(buildKey);
    }
  } catch {
    // Fire-and-forget: see the module doc comment. Nothing to recover here.
  }
}

let flushing = false;
let queued: {
  assistantId: string;
  buildKey: string;
  body: WebPresenceReportBody;
} | null = null;

/**
 * Report presence, keeping the daemon's view in generation order.
 *
 * `setClientWebPresence` stamps whatever arrives last and keeps it for the
 * whole TTL, so two concurrent posts that landed out of order would leave the
 * daemon believing this tab is on a conversation the user already left, and
 * suppress that conversation's pushes. Holding one request in flight at a time
 * makes the reorder unrepresentable without a sequence number on the wire.
 *
 * Only the newest report survives the wait: a superseded body describes a
 * state that is already wrong by the time it could be sent.
 *
 * A latched {@link isMachineAway} overrides whatever the caller computed. Every
 * report goes through here, so clamping once is what keeps the handlers that
 * answer from a window signal rather than from {@link isPresent}
 * (`app.attention`, `app.resume`, and the input listener) from reporting a
 * machine behind its lock screen as watching.
 */
function reportWebPresence(
  assistantId: string,
  buildKey: string,
  body: WebPresenceReportBody,
): void {
  queued = {
    assistantId,
    buildKey,
    body: isMachineAway() ? { ...body, visible: false } : body,
  };
  if (flushing) {
    return;
  }
  flushing = true;
  void (async () => {
    try {
      while (queued) {
        const next = queued;
        queued = null;
        await postWebPresence(next.assistantId, next.buildKey, next.body);
      }
    } finally {
      flushing = false;
    }
  })();
}

/** Drop queue state between tests so one test cannot strand another. */
export function __resetWebPresenceQueueForTests(): void {
  flushing = false;
  queued = null;
  screenLocked = false;
  systemSuspended = false;
  routeMissingBuilds.clear();
}

/**
 * @param assistantId current assistant; `null` disables reporting until an
 *   assistant resolves.
 */
export function useWebPresenceReport(assistantId: string | null): void {
  const location = useLocation();
  const activeConversationId = useConversationStore.use.activeConversationId();
  const supportsWebPresence = useSupportsWebPresence(assistantId);
  // Identifies the daemon build on the other end, so a 404 is remembered
  // against that build alone and an upgrade under a live tab is retried.
  const version = useAssistantIdentityStore.use.version();
  const buildKey = `${assistantId}@${version}`;
  // Read off a ref by the timer and the input listener for the same reason
  // the focused conversation is: an upgrade under a live tab should reach
  // them without re-arming either.
  const buildKeyRef = useRef(buildKey);
  useEffect(() => {
    buildKeyRef.current = buildKey;
  }, [buildKey]);

  const focusedConversationId = isConversationChatPath(location.pathname)
    ? activeConversationId
    : null;
  // The reconciliation interval reads the focused conversation off a ref
  // rather than depending on it, so a focus change doesn't tear down and
  // re-arm the timer, which the effect below already covers.
  const focusedConversationIdRef = useRef(focusedConversationId);
  useEffect(() => {
    focusedConversationIdRef.current = focusedConversationId;
  }, [focusedConversationId]);

  // Presence is visibility AND recent input. `visibilityState` alone stays
  // `visible` for a tab abandoned on a second monitor, which would suppress
  // every reply push while nobody is reading it.
  const lastInteractionAtRef = useRef(0);
  // Stamped in an effect rather than at `useRef`, which `react-hooks/purity`
  // forbids, and declared ahead of the reporting effects so the stamp lands
  // before the first report reads it.
  //
  // A browser tab mounts because the user navigated to it, so its mount is
  // input. A desktop renderer mounts on its own: it launches at login,
  // reloads after a crash, and starts up behind a lock screen, where the
  // window reads visible, focused and unminimized and no lock edge has
  // reached {@link screenLocked}. The desktop counts real input only, so a
  // renderer nobody is at reports away and the reply reaches the phone.
  useEffect(() => {
    if (isElectron()) {
      return;
    }
    lastInteractionAtRef.current = Date.now();
  }, []);

  /**
   * Report this client as away. A locked screen or a suspended machine leaves
   * the window visible, focused and unminimized, so no window signal and no
   * DOM read says the user left, and the idle clock only expires ten minutes
   * after the last keystroke. Reporting at once is what sends the reply to
   * the phone the user walked away with.
   */
  const reportAway = () => {
    if (!supportsWebPresence) {
      return;
    }
    reportWebPresence(assistantId!, buildKey, {
      visible: false,
      focusedConversationId,
    });
  };

  /** Report whatever this client's own state says, on the way back. */
  const reportPresence = () => {
    if (!supportsWebPresence) {
      return;
    }
    reportWebPresence(assistantId!, buildKey, {
      visible: isPresent(lastInteractionAtRef.current),
      focusedConversationId,
    });
  };

  useBusSubscription("app.resume", ({ signal }) => {
    if (!supportsWebPresence) {
      return;
    }
    if (signal === "online") {
      // Reachability, not a foreground edge. It says nothing about where the
      // user is, so the DOM and the idle clock still decide.
      reportPresence();
      return;
    }
    // In a browser the edge is the evidence, not `visibilityState`. On iOS
    // the Capacitor app-state source and the DOM event describe one physical
    // edge and `lifecycle-edge.ts` publishes only the first to arrive, so the
    // DOM can still read stale here and the losing source never fires to
    // correct it. The desktop publishes no lifecycle edge, so one arriving
    // under Electron came from the DOM source, which cannot see where a
    // Vellum window is; real window state decides there.
    lastInteractionAtRef.current = Date.now();
    reportWebPresence(assistantId!, buildKey, {
      visible: isElectron() ? isVisibleToUser() : true,
      focusedConversationId,
    });
  });

  useBusSubscription("app.hidden", () => {
    // Authoritative for the same reason the resume edge is: backgrounded is
    // what the edge means, whatever the DOM has caught up to.
    reportAway();
  });

  useBusSubscription("app.attention", ({ attended }) => {
    if (!supportsWebPresence) {
      return;
    }
    // A desktop window can lose focus while staying on screen, which is not a
    // lifecycle edge. Reporting here rather than letting the last report age
    // out of the daemon's TTL is what keeps a reply to the conversation that
    // window was showing from being suppressed for minutes after the user
    // moved on. The edge carries where the window went; the idle clock still
    // decides whether the user is at this client at all.
    reportWebPresence(assistantId!, buildKey, {
      visible: attended && hasRecentInput(lastInteractionAtRef.current),
      focusedConversationId,
    });
  });

  useBusSubscription("power.lock", () => {
    screenLocked = true;
    reportAway();
  });

  useBusSubscription("power.suspend", () => {
    systemSuspended = true;
    reportAway();
  });

  useBusSubscription("power.unlock", () => {
    // An unlock is the user standing at the machine, so it clears both: a
    // sleep whose wake was never reported cannot outlive the person typing
    // their password.
    screenLocked = false;
    systemSuspended = false;
    reportPresence();
  });

  useBusSubscription("power.resume", () => {
    // Clears the suspend it answers and leaves the lock alone: a machine
    // wakes to its lock screen, so waking is not evidence the user is back.
    // See {@link screenLocked}.
    systemSuspended = false;
    reportPresence();
  });

  useBusSubscription("sse.opened", ({ assistantId: openedFor }) => {
    if (supportsWebPresence && assistantId === openedFor) {
      reportWebPresence(assistantId!, buildKey, {
        visible: isPresent(lastInteractionAtRef.current),
        focusedConversationId: focusedConversationIdRef.current,
      });
    }
  });

  // Stamp user input, and when it ends an idle stretch report at once so
  // suppression resumes without waiting for the next tick.
  useEffect(() => {
    if (!supportsWebPresence) {
      return;
    }
    const onInteraction = () => {
      const wasIdle = !isPresent(lastInteractionAtRef.current);
      lastInteractionAtRef.current = Date.now();
      if (wasIdle && isVisibleToUser()) {
        reportWebPresence(assistantId!, buildKeyRef.current, {
          visible: true,
          focusedConversationId: focusedConversationIdRef.current,
        });
      }
    };
    for (const name of INTERACTION_EVENTS) {
      window.addEventListener(name, onInteraction, {
        passive: true,
        capture: true,
      });
    }
    return () => {
      for (const name of INTERACTION_EVENTS) {
        window.removeEventListener(name, onInteraction, { capture: true });
      }
    };
  }, [assistantId, supportsWebPresence]);

  // Mount + focused-conversation-change reporter. Reads visibility fresh at
  // post time rather than depending on lifecycle state, so a visibility flip
  // (already reported above) doesn't trigger a second, redundant report.
  // `buildKey` is a dependency so an upgrade under a live tab reports at once
  // rather than waiting for the next edge or tick.
  useEffect(() => {
    if (!supportsWebPresence) {
      return;
    }
    reportWebPresence(assistantId!, buildKey, {
      visible: isPresent(lastInteractionAtRef.current),
      focusedConversationId,
    });
  }, [assistantId, buildKey, focusedConversationId, supportsWebPresence]);

  // Reconcile semantic presence slowly while present. A hidden or idle tab
  // skips the tick and its last report ages out of the daemon's TTL, which
  // restores the push; the next visibility edge or input reports fresh state.
  useEffect(() => {
    if (!supportsWebPresence) {
      return;
    }
    const intervalId = window.setInterval(() => {
      if (!isPresent(lastInteractionAtRef.current)) {
        return;
      }
      reportWebPresence(assistantId!, buildKeyRef.current, {
        visible: true,
        focusedConversationId: focusedConversationIdRef.current,
      });
    }, RECONCILIATION_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [assistantId, supportsWebPresence]);
}
