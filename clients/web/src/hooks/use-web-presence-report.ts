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
 * there — never reuse the macOS host-proxy presence path for this.
 *
 * Reports on mount, on every visibility edge (via the bus's `app.resume` /
 * `app.hidden`, not a raw `visibilitychange` listener — see
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
 * remainder of the TTL — it never blocks the UI or breaks chat.
 */
import { useEffect, useRef } from "react";
import { useLocation } from "react-router";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { isElectron } from "@/runtime/is-electron";
import { useConversationStore } from "@/stores/conversation-store";
import { isConversationChatPath } from "@/utils/routes";

interface WebPresenceReportBody {
  visible: boolean;
  focusedConversationId: string | null;
}

/** See the module doc comment for the sizing rationale. */
const RECONCILIATION_INTERVAL_MS = 60_000;

function isDocumentVisible(): boolean {
  return (
    typeof document === "undefined" || document.visibilityState === "visible"
  );
}

async function postWebPresence(
  assistantId: string,
  body: WebPresenceReportBody,
): Promise<void> {
  try {
    await daemonClient.post({
      url: "/v1/assistants/{assistant_id}/clients/web-presence",
      path: { assistant_id: assistantId },
      body,
    });
  } catch {
    // Fire-and-forget: see the module doc comment. Nothing to recover here.
  }
}

/**
 * @param assistantId — current assistant; `null` disables reporting until an
 *   assistant resolves.
 */
export function useWebPresenceReport(assistantId: string | null): void {
  const location = useLocation();
  const activeConversationId = useConversationStore.use.activeConversationId();

  const focusedConversationId = isConversationChatPath(location.pathname)
    ? activeConversationId
    : null;
  // The reconciliation interval reads the focused conversation off a ref
  // rather than depending on it, so a focus change doesn't tear down and
  // re-arm the timer — it's already covered by the effect below.
  const focusedConversationIdRef = useRef(focusedConversationId);
  useEffect(() => {
    focusedConversationIdRef.current = focusedConversationId;
  }, [focusedConversationId]);

  useBusSubscription("app.resume", () => {
    if (assistantId && !isElectron()) {
      void postWebPresence(assistantId, {
        visible: isDocumentVisible(),
        focusedConversationId,
      });
    }
  });

  useBusSubscription("app.hidden", () => {
    if (assistantId && !isElectron()) {
      void postWebPresence(assistantId, {
        visible: isDocumentVisible(),
        focusedConversationId,
      });
    }
  });

  // Mount + focused-conversation-change reporter. Reads visibility fresh at
  // post time rather than depending on lifecycle state, so a visibility flip
  // (already reported above) doesn't trigger a second, redundant report.
  useEffect(() => {
    if (!assistantId || isElectron()) {
      return;
    }
    void postWebPresence(assistantId, {
      visible: isDocumentVisible(),
      focusedConversationId,
    });
  }, [assistantId, focusedConversationId]);

  // Reconcile semantic presence slowly while visible. A hidden tab skips the
  // tick; the next real visibility edge reports its fresh state.
  useEffect(() => {
    if (!assistantId || isElectron()) {
      return;
    }
    const intervalId = window.setInterval(() => {
      if (!isDocumentVisible()) {
        return;
      }
      void postWebPresence(assistantId, {
        visible: true,
        focusedConversationId: focusedConversationIdRef.current,
      });
    }, RECONCILIATION_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [assistantId]);
}
