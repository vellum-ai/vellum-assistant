/**
 * Reports web tab visibility and focused-conversation state to the daemon,
 * so a `chat.assistant_reply` APNs push can be suppressed when the reply's
 * own conversation is already open and visible in this tab (see
 * `assistant/src/runtime/web-presence.ts`).
 *
 * Browser-only: the Electron desktop renderer already reports its own
 * attendance through the native host-proxy bridge (`clients/macos`), and its
 * turns are tagged `clientOs: "macos"` / `"windows"` rather than `"web"`
 * (`detectClientOs()` resolves the Electron bridge first), so the daemon
 * gate this hook feeds would never be consulted for an Electron-originated
 * turn. Reporting from Electron would be pure waste, so this hook no-ops
 * there. Never reuse the macOS host-proxy presence path for this.
 *
 * Reports on mount, on every visibility edge (via the bus's `app.resume` /
 * `app.hidden`, not a raw `visibilitychange` listener, see
 * `docs/EVENT_BUS.md`), whenever the focused conversation changes (route or
 * active-conversation-id change), and on a periodic reconciliation tick while
 * the tab is visible. Each report reads `document.visibilityState` at post
 * time rather than trusting cached lifecycle state. This intentionally uses
 * visibility-only semantics: `document.hasFocus()` is window-level and can be
 * false for a visible tab in an unfocused browser window, while visibility is
 * the existing contract for whether the conversation is on screen.
 * "Focused" mirrors `useNotificationIntentSync`'s own check: the
 * active conversation id only counts while the chat composer for that
 * conversation is actually on screen, since `activeConversationId` is never
 * cleared on navigation away.
 *
 * Visibility is necessary but not sufficient: a tab left on a second monitor
 * reports `visible` forever, so a tab with no user input for
 * `IDLE_THRESHOLD_MS` stops counting and its report ages out of the daemon's
 * TTL, restoring the push. This mirrors the desktop reporter, which derives
 * attendance from system idle time for the same reason.
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

function isDocumentVisible(): boolean {
  return (
    typeof document === "undefined" || document.visibilityState === "visible"
  );
}

/**
 * Whether this tab currently counts as presence: on screen, and touched by
 * the user inside {@link IDLE_THRESHOLD_MS}.
 */
function isPresent(lastInteractionAt: number): boolean {
  return (
    isDocumentVisible() && Date.now() - lastInteractionAt <= IDLE_THRESHOLD_MS
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
 */
function reportWebPresence(
  assistantId: string,
  buildKey: string,
  body: WebPresenceReportBody,
): void {
  queued = { assistantId, buildKey, body };
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
  // forbids. Declared ahead of the reporting effects so mount, which is the
  // user arriving, counts as input before the first report reads it.
  useEffect(() => {
    lastInteractionAtRef.current = Date.now();
  }, []);

  useBusSubscription("app.resume", ({ signal }) => {
    if (!supportsWebPresence || isElectron()) {
      return;
    }
    if (signal === "online") {
      // Reachability, not a foreground edge. It says nothing about where the
      // user is, so the DOM and the idle clock still decide.
      reportWebPresence(assistantId!, buildKey, {
        visible: isPresent(lastInteractionAtRef.current),
        focusedConversationId,
      });
      return;
    }
    // The edge is the evidence, not `visibilityState`. On iOS the Capacitor
    // app-state source and the DOM event describe one physical edge and
    // `lifecycle-edge.ts` publishes only the first to arrive, so the DOM can
    // still read stale here and the losing source never fires to correct it.
    lastInteractionAtRef.current = Date.now();
    reportWebPresence(assistantId!, buildKey, {
      visible: true,
      focusedConversationId,
    });
  });

  useBusSubscription("app.hidden", () => {
    if (supportsWebPresence && !isElectron()) {
      // Authoritative for the same reason the resume edge is: backgrounded is
      // what the edge means, whatever the DOM has caught up to.
      reportWebPresence(assistantId!, buildKey, {
        visible: false,
        focusedConversationId,
      });
    }
  });

  useBusSubscription("sse.opened", ({ assistantId: openedFor }) => {
    if (supportsWebPresence && !isElectron() && assistantId === openedFor) {
      reportWebPresence(assistantId!, buildKey, {
        visible: isPresent(lastInteractionAtRef.current),
        focusedConversationId: focusedConversationIdRef.current,
      });
    }
  });

  // Stamp user input, and when it ends an idle stretch report at once so
  // suppression resumes without waiting for the next tick.
  useEffect(() => {
    if (!supportsWebPresence || isElectron()) {
      return;
    }
    const onInteraction = () => {
      const wasIdle = !isPresent(lastInteractionAtRef.current);
      lastInteractionAtRef.current = Date.now();
      if (wasIdle && isDocumentVisible()) {
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
    if (!supportsWebPresence || isElectron()) {
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
    if (!supportsWebPresence || isElectron()) {
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
