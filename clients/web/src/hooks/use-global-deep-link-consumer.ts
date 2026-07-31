import { useLayoutEffect, useRef } from "react";
import * as Sentry from "@sentry/react";
import { useNavigate } from "react-router";

import { useBusSubscription } from "@/hooks/use-bus-subscription";
import {
  isLiveVoiceSessionActive,
  restoreVoiceRoom,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { requestVoiceStartFromDeepLink } from "@/domains/chat/voice/live-voice/start-voice-deep-link";
import { ensureMainWindowVisible } from "@/runtime/main-window";
import { useConversationStore } from "@/stores/conversation-store";
import { usePendingDeepLinkStore } from "@/stores/pending-deep-link-store";
import { useViewerStore } from "@/stores/viewer-store";
import { navigateToConversation } from "@/utils/conversation-navigation";
import { routes } from "@/utils/routes";

/**
 * Global deep-link consumer — mounted at `RootLayout` so it's alive
 * for every authenticated assistant route, not just `/assistant`
 * (`ChatPage`). Without it, a `vellum://thread/...` click while the
 * user is on `/assistant/settings` would be dropped.
 *
 * Responsibilities:
 *
 * - `deeplink.openThread` → `ensureMainWindowVisible()` +
 *   `navigateToConversation()`
 * - `deeplink.send` → `ensureMainWindowVisible()` + navigate to
 *   `/assistant` + park the message in `usePendingDeepLinkStore`
 *   for `ChatPage`'s composer-domain hook to consume on mount.
 * - `deeplink.billingCheckoutComplete` → `ensureMainWindowVisible()`
 *   + navigate to billing carrying the Stripe `session_id` (which
 *   opens the Pro onboarding wizard), or to the upgrade-cancel page
 *   on `status: "cancel"` — the same landing the web flow uses.
 * - `deeplink.startVoice` → `ensureMainWindowVisible()` + navigate,
 *   then hand the request to the live-voice starter (parked for the
 *   cold-launch case — see `start-voice-deep-link.ts`). `mode: "resume"`
 *   just navigates back to a running session's conversation. A `prompt`
 *   (Siri's "Ask …" intent, which collects the question before the app is
 *   up) is parked in the composer inbox — see below.
 * - `deeplink.unknown` → Sentry breadcrumb.
 *
 * ## Why a start-voice `prompt` goes to the composer, not into the session
 *
 * A live-voice session has no representation of a *text* user turn. Its wire
 * protocol (`domains/chat/voice/live-voice/protocol.ts`, mirroring
 * `assistant/src/live-voice/protocol.ts`) carries exactly five client frames —
 * `start`, `ptt_release`, `interrupt`, `end`, `update_config` — plus raw PCM on
 * binary frames. A user turn *is* the audio: the daemon's server-VAD turn
 * detector segments the PCM stream and transcribes it. There is no seam that
 * accepts words, and the `start` frame carries no seed prompt.
 *
 * The two ways to invent one are both wrong for this change. Routing the text
 * through `processMessage` would widen the very divergence that live voice
 * deliberately avoids and that has already produced a bug class of its own
 * (missing `user_message_echo`, an unpersisted conversation row, a missing
 * `trustContext`). Adding a text client frame is a daemon protocol change with
 * its own compatibility gate, not something to smuggle in behind a Siri phrase.
 *
 * So the session starts exactly as a plain `mode=new` link starts it, and the
 * spoken text is surfaced in the composer where the user can send it — visible
 * and under their control rather than silently dropped. When a text-turn frame
 * exists, this is the one line that changes.
 *
 * The composer pre-fill itself stays in the chat domain
 * (`useDeepLinkConsumer`) because it owns `setInput`. This hook stays
 * generic — chat-specific store handling lives in the shared
 * `navigateToConversation` util.
 */

export function useGlobalDeepLinkConsumer(): void {
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  useLayoutEffect(() => {
    navigateRef.current = navigate;
  });

  useBusSubscription("deeplink.send", ({ message }) => {
    void ensureMainWindowVisible();
    usePendingDeepLinkStore.getState().setPendingComposerMessage(message);
    navigateRef.current(routes.assistant);
  });

  const openThread = (threadId: string) => {
    // Same thread: skip store resets — the id doesn't change, so re-seed effects wouldn't re-run and live cards would vanish.
    if (threadId === useConversationStore.getState().activeConversationId) {
      useViewerStore.getState().setMainView("chat");
      navigateRef.current(routes.conversation(threadId));
      return;
    }
    navigateToConversation(navigateRef.current, threadId);
  };

  useBusSubscription("deeplink.openThread", ({ threadId }) => {
    void ensureMainWindowVisible();
    openThread(threadId);
  });

  // `mode` is deliberately not read. The two modes have collapsed onto the
  // same behavior — `resume` degrades to `new` with nothing running, and `new`
  // degrades to surfacing the call with something running — so consulting it
  // today would only look like a distinction the code does not make. It comes
  // back the moment there is a product answer for what "new conversation"
  // should do to a call in progress; the field stays on the payload for that,
  // and because the URL contract is shared with the native producers.
  useBusSubscription("deeplink.startVoice", ({ prompt }) => {
    void ensureMainWindowVisible();
    // The composer inbox rather than the session — see the note above the hook.
    // Reusing `deeplink.send`'s one-shot store buys exactly-once delivery: the
    // chat domain consumes and clears, so no re-render or reconnect replays it.
    // Parked ahead of the mode branch so a `resume` link carrying text does not
    // drop what the user said on its early return.
    if (prompt !== null) {
      usePendingDeepLinkStore.getState().setPendingComposerMessage(prompt);
    }
    const session = useLiveVoiceStore.getState();
    // A running session is surfaced, never doubled — for *either* mode. The
    // room renders itself off `useIsVoiceRoomVisible` once the owning composer
    // is on screen, so landing on the right conversation is the whole job.
    //
    // `resume` is the Live Activity's tap-to-return, and with nothing running
    // it degrades to `new`. `new` degrades the other way: the starter already
    // returns early for any active phase (`use-live-voice.ts`), so falling
    // through to it mid-call would navigate the user *away* from the
    // conversation that owns their live session and then start nothing — the
    // Action Button and the Control Center control would read as broken. Until
    // there is a product answer for what "new conversation" should do to a call
    // in progress (end and replace it, or refuse), surfacing the session the
    // user is already in is the honest behavior: nothing is lost and the
    // command visibly did something.
    if (isLiveVoiceSessionActive(session.state)) {
      // Un-minimize first. The room is what the user tapped the island *for*,
      // and `useIsVoiceRoomVisible` gates on `!roomMinimized` — so without this
      // a session minimized before the phone was locked lands back on the
      // composer's voice bar and the tap reads as doing nothing at all (worse
      // on the same-conversation path, where the navigation below is a no-op
      // and nothing on screen changes). Tapping the island is an explicit
      // "show me the call", which outranks a minimize from before the lock.
      restoreVoiceRoom();
      // `startedConversationId` first — ownership is a *composer binding*, not
      // wire identity, and this is the id the owning composer is bound to. A
      // composer that started the session on a client-side draft id keeps that
      // id here while `conversationId` becomes the server's, so landing on the
      // latter would navigate away from the composer that owns the session.
      // (`use-live-voice`'s reconnect paths take the opposite precedence: they
      // need the conversation the *transport* reattaches to.) `conversationId`
      // is the fallback for a session started without one, where `ready`
      // assigns it and `startedConversationId` stays `null`.
      const target = session.startedConversationId ?? session.conversationId;
      if (target !== null) {
        openThread(target);
      } else {
        // Pre-`ready` draft session — the draft composer owns it.
        navigateRef.current(routes.assistant);
      }
      return;
    }
    // The draft composer (no conversation): the session starts without one and
    // the server assigns it on `ready`.
    navigateRef.current(routes.assistant);
    requestVoiceStartFromDeepLink();
  });

  useBusSubscription(
    "deeplink.billingCheckoutComplete",
    ({ status, sessionId }) => {
      void ensureMainWindowVisible();
      navigateRef.current(
        status === "success"
          ? routes.settings.usageBillingCheckout(sessionId)
          : routes.settings.upgradeCancel,
      );
    },
  );

  useBusSubscription("deeplink.unknown", ({ url }) => {
    Sentry.addBreadcrumb({
      category: "deeplink",
      level: "info",
      message: "deeplink.unknown",
      data: { url },
    });
  });
}
