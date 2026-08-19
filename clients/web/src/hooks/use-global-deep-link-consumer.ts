import { useLayoutEffect, useRef } from "react";
import * as Sentry from "@sentry/react";
import { useNavigate } from "react-router";

import { useQueryClient } from "@tanstack/react-query";

import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { notifyCheckoutSuccess } from "@/lib/billing/checkout-success";
import { requestComposerFocus } from "@/domains/chat/composer-focus";
import {
  isLiveVoiceSessionActive,
  restoreVoiceRoom,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { requestVoiceStart } from "@/domains/chat/voice/live-voice/start-voice-request";
import { ensureMainWindowVisible } from "@/runtime/main-window";
import { useConnectDialogStore } from "@/stores/connect-dialog-store";
import { useConversationStore } from "@/stores/conversation-store";
import { usePendingDeepLinkStore } from "@/stores/pending-deep-link-store";
import {
  navigateToConversation,
  navigateToNewConversation,
  revealConversationView,
} from "@/utils/conversation-navigation";
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
 * - `deeplink.sendToThread` → same navigation into the *target* thread.
 *   With proven provenance the message is parked as a send request the
 *   chat domain fulfils on arrival; otherwise it is parked as a composer
 *   pre-fill with focus requested. See the provenance note below.
 * - `deeplink.send` → `ensureMainWindowVisible()` + navigate to
 *   `/assistant` + park the message in `usePendingDeepLinkStore`
 *   for `ChatPage`'s composer-domain hook to consume on mount.
 * - `deeplink.billingCheckoutComplete` → `ensureMainWindowVisible()`,
 *   then branch on `flow`. A `subscription` checkout navigates to
 *   billing carrying the Stripe `session_id` (which opens the Pro
 *   onboarding wizard), or to the upgrade-cancel page on
 *   `status: "cancel"` (the same landing the web flow uses). A
 *   `top_up` checkout toasts and refetches the billing summary on
 *   success (no forced navigation), and on cancel lands on billing
 *   with `billing_status=cancel`, funneling into the billing page's
 *   server-verified checkout-bonus offer flow.
 * - `deeplink.startVoice` → `ensureMainWindowVisible()` + navigate,
 *   then hand the request to the live-voice starter (parked for the
 *   cold-launch case, see `start-voice-request.ts`). `mode: "resume"`
 *   just navigates back to a running session's conversation. A `prompt`
 *   (Siri's "Ask …" intent, which collects the question before the app is
 *   up) is asked as a text turn when its provenance is proven and
 *   pre-fills the composer otherwise; no session starts for it either
 *   way. See below.
 * - `deeplink.connect` → `ensureMainWindowVisible()` + park the request
 *   in the connect-dialog store + navigate to the assistant chooser,
 *   which opens its Connect a Remote Assistant dialog off that store: a
 *   `bundle` prefills the paste field; a bundle-less link (the pair
 *   page's url+code hand-off, which cannot complete a durable desktop
 *   pairing) gets guidance naming the host instead.
 * - `deeplink.unknown` → Sentry breadcrumb.
 *
 * ## Deep-link text: proven provenance sends, anything else pre-fills
 *
 * A custom URL scheme carries no caller identity: any installed app or web
 * page can open `<scheme>://voice?prompt=…` or `<scheme>://thread/<id>?message=…`,
 * so acting on such text automatically would let an arbitrary link put words
 * in the user's mouth and run a tool-capable turn with them. The parser
 * bounds the *shape* of the text (`sanitizeDeepLinkText`); it cannot vouch
 * for its *intent*. So by default deep-linked text lands visibly in the
 * composer (the `deeplink.send` park) with focus requested, one tap from
 * sent, and only the user sends it.
 *
 * The iOS shell can prove one origin, though. App Intents (a Shortcut, Siri,
 * the Action Button) run in-process on the user's explicit action and hand
 * their URL to the delegate directly; every URL from outside the process
 * enters through two methods where the shell strips the provenance marker
 * (`CommandURLProvenance.swift`, LUM-3281). The Capacitor source honors the
 * marker only on iOS, so `provenance: "intent"` on a payload means exactly
 * "the user ran an intent". That text may be sent for them: a voice prompt
 * as a text turn in a fresh conversation, a thread message into its thread
 * once the chat domain confirms the target exists (`useDeepLinkThreadSend`).
 * Everything with `provenance: null` keeps the pre-fill contract.
 *
 * ## Why a start-voice `prompt` starts no session, even when proven
 *
 * A live-voice session has no
 * representation of a *text* user turn. Its wire protocol
 * (`domains/chat/voice/live-voice/protocol.ts`, mirroring
 * `assistant/src/live-voice/protocol.ts`) carries control frames plus raw PCM
 * on binary frames. A user turn *is* the audio: the daemon's server-VAD turn
 * detector segments the PCM stream and transcribes it. There is no seam that
 * accepts words, and the `start` frame carries no seed prompt (JARVIS-1522
 * tracks adding one). Routing the text through `processMessage` into the
 * conversation a live session owns is not an option either: it widens the
 * very divergence that live voice deliberately avoids and that has produced
 * a bug class of its own (missing `user_message_echo`, an unpersisted
 * conversation row, a missing `trustContext`). A session started alongside
 * the prompt could not hear the question, and its full-screen room would
 * hide the pre-fill. So a proven prompt is asked as a *text* turn; the
 * spoken answer waits on JARVIS-1522's seed-turn seam, and the
 * `deeplink.startVoice` handler marks the line that changes when it lands.
 *
 * A prompt arriving while a call is already live parks as a pre-fill
 * regardless of provenance, minus the navigation and focus: the call is
 * surfaced and the text waits in the owning composer, because there is no
 * way to hand it to the running session. The composer pre-fill itself stays in the chat domain
 * (`useDeepLinkConsumer`) because it owns `setInput`. This hook stays
 * generic; chat-specific store handling lives in the shared
 * `navigateToConversation` util.
 */

/**
 * Guidance for a connect link that carried no bundle: the pair page's
 * url+code hand-off. The device-code exchange cannot produce a durable
 * desktop pairing (its refresh token is an HttpOnly cookie), so the
 * dialog explains how to get a pastable bundle instead. Named host only
 * when the link carried a parseable https base.
 */
function connectGuidanceMessage(url: string | null): string {
  let host: string | null = null;
  if (url !== null) {
    try {
      host = new URL(url).host;
    } catch {
      // Main-side validation makes this unreachable; guidance degrades
      // to the hostless copy.
    }
  }
  const machine =
    host === null
      ? "the assistant's machine"
      : `the assistant's machine at ${host}`;
  return `This link came from a pairing QR code. To connect this Mac, run vellum pair on ${machine} and paste the bundle here.`;
}

export function useGlobalDeepLinkConsumer(): void {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
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
      revealConversationView(threadId);
      navigateRef.current(routes.conversation(threadId));
      return;
    }
    navigateToConversation(navigateRef.current, threadId);
  };

  useBusSubscription("deeplink.openThread", ({ threadId }) => {
    void ensureMainWindowVisible();
    openThread(threadId);
  });

  // The iOS "Send Message to Chat" Shortcuts action. What happens to the
  // message depends on whether the shell proved an App Intent produced the
  // link (see the provenance note above the hook):
  //
  // - Proven: park a send request and land in the thread. The chat domain
  //   (`useDeepLinkThreadSend`) sends it once the target is confirmed to
  //   exist and pre-fills instead when it is not, so a stale picker id
  //   cannot mint a new conversation. Nothing sends from here directly.
  // - Unproven: pre-fill and focus, one tap from sent, exactly as before.
  useBusSubscription(
    "deeplink.sendToThread",
    ({ threadId, message, provenance }) => {
      void ensureMainWindowVisible();
      if (provenance === "intent") {
        usePendingDeepLinkStore
          .getState()
          .setPendingThreadSend(threadId, message);
        openThread(threadId);
        return;
      }
      usePendingDeepLinkStore.getState().setPendingComposerMessage(message);
      openThread(threadId);
      requestComposerFocus();
    },
  );

  // `mode` is deliberately not read. The two modes have collapsed onto the
  // same behavior — `resume` degrades to `new` with nothing running, and `new`
  // degrades to surfacing the call with something running — so consulting it
  // today would only look like a distinction the code does not make. It comes
  // back the moment there is a product answer for what "new conversation"
  // should do to a call in progress; the field stays on the payload for that,
  // and because the URL contract is shared with the native producers.
  useBusSubscription("deeplink.startVoice", ({ prompt, provenance }) => {
    void ensureMainWindowVisible();
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
      // Text cannot become a turn in the running session (see the note above
      // the hook), and tearing the user out of their call over it would be
      // worse. Park it in `deeplink.send`'s one-shot store, which buys
      // exactly-once delivery: the chat domain consumes and clears, so no
      // re-render or reconnect replays it into the composer.
      if (prompt !== null) {
        usePendingDeepLinkStore.getState().setPendingComposerMessage(prompt);
      }
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
    // A prompt with no call in progress starts no session either way (the
    // protocol has no text turn; see the note above the hook). What happens
    // to the text depends on provenance:
    //
    // - Proven intent (Siri collected it on the user's explicit action):
    //   ask it as a text turn in a fresh conversation. `navigateToNewConversation`
    //   mints a *registered* draft and rides the `?prompt=` auto-send, the
    //   pathway quick input and the launch buttons use, so no target-integrity
    //   question arises. The answer is text, not speech, until JARVIS-1522
    //   gives the voice session a seed turn.
    // - Unproven: pre-fill and focus, one tap from sent.
    if (prompt !== null) {
      if (provenance === "intent") {
        navigateToNewConversation(navigateRef.current, { prompt });
        return;
      }
      usePendingDeepLinkStore.getState().setPendingComposerMessage(prompt);
      navigateRef.current(routes.assistant);
      requestComposerFocus();
      return;
    }
    // The draft composer (no conversation): the session starts without one and
    // the server assigns it on `ready`.
    navigateRef.current(routes.assistant);
    requestVoiceStart();
  });

  useBusSubscription(
    "deeplink.billingCheckoutComplete",
    ({ status, sessionId, flow }) => {
      void ensureMainWindowVisible();
      if (flow === "top_up") {
        if (status === "success") {
          // No forced navigation: a top-up has no onboarding wizard to open,
          // so the user stays wherever they were.
          notifyCheckoutSuccess(queryClient);
          return;
        }
        // `billing_status=cancel` funnels into `BillingStatusHandler`, the
        // single owner of the server-verified checkout-bonus offer flow,
        // so the native cancel gets the identical treatment as the web one.
        // `usageBilling` already carries `?tab=billing`, hence the `&`.
        navigateRef.current(
          `${routes.settings.usageBilling}&billing_status=cancel`,
        );
        return;
      }
      navigateRef.current(
        status === "success"
          ? routes.settings.usageBillingCheckout(sessionId)
          : routes.settings.upgradeCancel,
      );
    },
  );

  useBusSubscription("deeplink.connect", ({ url, bundle }) => {
    void ensureMainWindowVisible();
    // Park before navigating so the chooser mounts with the dialog
    // already open (its auto-skip stands down while it is).
    useConnectDialogStore.getState().openConnectDialog(
      bundle !== null
        ? { initialBundle: bundle }
        : { guidanceMessage: connectGuidanceMessage(url) },
    );
    navigateRef.current(routes.selectAssistant);
  });

  useBusSubscription("deeplink.unknown", ({ url }) => {
    Sentry.addBreadcrumb({
      category: "deeplink",
      level: "info",
      message: "deeplink.unknown",
      data: { url },
    });
  });
}
