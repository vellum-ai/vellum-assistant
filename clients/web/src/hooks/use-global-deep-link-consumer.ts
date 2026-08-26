import { useLayoutEffect, useRef } from "react";
import * as Sentry from "@sentry/react";
import { useLocation, useNavigate } from "react-router";

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
import { pairingLinkForBase } from "@/utils/pairing-address";
import { conversationIdForPath, routes } from "@/utils/routes";

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
 * - `deeplink.newChat` → `ensureMainWindowVisible()` +
 *   `navigateToNewConversation()`, the Home Screen widgets' New Chat button.
 * - `deeplink.openCamera` → `ensureMainWindowVisible()`, then reveal the chat
 *   and stay put on a conversation route, or land on a fresh draft from
 *   anywhere else, and park the request in `usePendingDeepLinkStore` addressed
 *   to whichever conversation that was, for its composer's attachment layer to
 *   drain (`useCameraDeepLink`).
 * - `deeplink.openConversations` → `ensureMainWindowVisible()`, then land on
 *   the chat if the current route is not already a conversation, and park the
 *   request for `ChatLayout` to drain into the conversation list (the mobile
 *   drawer, or the sidebar on a wider window).
 * - `deeplink.connect` → `ensureMainWindowVisible()` + park the request
 *   in the connect-dialog store + navigate to the assistant chooser,
 *   which opens its Connect a Remote Assistant dialog off that store.
 *   A `url`+`code` link recomposes into the pairing link and prefills the
 *   address field, so the pair completes on one click; a link carrying
 *   only a base prefills that, and the dialog mints its own approval
 *   code. A link with no usable base gets guidance instead of a prefill,
 *   naming its legacy pairing bundle when it carried one.
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
 * The address a `connect` deep link asks the dialog to pair with. A link
 * carrying a device code recomposes into the pairing link the local-mode host
 * exchanges outright; a link carrying only a base becomes the bare address,
 * which mints its own approval code. `null` when the link carried no usable
 * base, leaving the dialog nothing to submit.
 */
function connectAddress(
  url: string | null,
  code: string | null,
): string | null {
  if (url === null) {
    return null;
  }
  if (code === null) {
    return url;
  }
  // The link the user sees in the address field, so it has to be one they can
  // also paste into another device's browser: the base plus the pair route,
  // not the base with a bare fragment hung off it.
  return pairingLinkForBase(url, code) ?? url;
}

export function useGlobalDeepLinkConsumer(): void {
  const navigate = useNavigate();
  const { pathname, search, hash } = useLocation();
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
    // The chat, so the layout that registers the starter is mounted. The drain
    // mints the fresh conversation the session binds to and lands on it from
    // there, reading the ref because it navigates after its own awaits.
    navigateRef.current(routes.assistant);
    requestVoiceStart((to, options) => navigateRef.current(to, options));
  });

  // The Home Screen widgets' New Chat buttons. `navigateToNewConversation` is
  // the same helper the in-app new-chat controls use, so the widget lands on a
  // registered draft with the composer focused rather than on a route the app
  // has no other way of reaching.
  useBusSubscription("deeplink.newChat", () => {
    void ensureMainWindowVisible();
    navigateToNewConversation(navigateRef.current);
  });

  // The Quick Actions widget's camera button. The camera input belongs to the
  // composer's attachment layer, which does not exist yet on a cold launch, so
  // the request is parked in the same one-shot inbox the voice start uses and
  // the composer drains it when it mounts (`useCameraDeepLink`).
  //
  // The landing has to be a route the composer *stays* mounted on, and a view
  // that mounts one at all. A composer already on screen keeps the photo in the
  // conversation the user is looking at, so the tap navigates nowhere and only
  // reveals the chat, which the full-screen app viewer would otherwise be
  // holding with `ChatMainPanel` swapped out (`ChatContentLayout`): the park
  // would sit there with no consumer, the tap would read as doing nothing, and
  // the camera would open by itself whenever the app was dismissed inside the
  // TTL. `revealConversationView` is the reveal `navigateToNewConversation`
  // runs below, so an app open beside the chat is kept either way. From
  // anywhere else the tap lands on a fresh draft, the same registered-draft
  // landing the New Chat button gets, silent because the tap was for the camera
  // and not for a new chat's flourish.
  useBusSubscription("deeplink.openCamera", () => {
    void ensureMainWindowVisible();
    // A named conversation only. The `/assistant` index mounts a composer too,
    // but `useConversationLoader` replace-navigates off it to a conversation
    // key on arrival, so a composer mounted there is remounted a beat later and
    // anything it holds in local state goes with it.
    const settledId = conversationIdForPath(pathname);
    let targetId: string;
    if (settledId !== null) {
      revealConversationView(settledId);
      // Re-navigating to the settled conversation is a no-op when the router
      // is at rest, and cancels any in-flight transition away from it that
      // would otherwise unmount the composer this park is addressed to. The
      // search and hash ride along so pending query-driven effects survive.
      navigateRef.current(
        { pathname: routes.conversation(settledId), search, hash },
        { replace: true },
      );
      targetId = settledId;
    } else {
      targetId = navigateToNewConversation(navigateRef.current, {
        silent: true,
      });
    }
    // Addressed to the conversation the tap lands on rather than broadcast to
    // whichever composer wakes first. The draft branch above has only *started*
    // its route transition, so a composer on the outgoing route is still
    // mounted and would otherwise spend this one-shot park on a viewfinder the
    // navigation takes down with it, leaving the draft's composer nothing.
    usePendingDeepLinkStore.getState().setPendingCamera(targetId);
  });

  // The Home Screen widgets' unread chip and unread line. The list they point
  // at is owned by `ChatLayout`, which is not mounted on a cold launch and
  // never mounts on settings / logs / account routes, so the request is parked
  // the way the camera's is and the layout drains it (`chat-layout.tsx`).
  //
  // The navigation is skipped on a settled conversation route: the layout is
  // already mounted there, and re-navigating would push a history entry for no
  // change on screen. Everywhere else lands on the chat, and the drain holds
  // the park across the replace-navigation that landing runs on arrival.
  useBusSubscription("deeplink.openConversations", () => {
    void ensureMainWindowVisible();
    if (conversationIdForPath(pathname) === null) {
      navigateRef.current(routes.assistant);
    }
    usePendingDeepLinkStore.getState().setPendingConversationList();
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

  // A usable address prefills the field and stops there. A custom URL scheme
  // carries no caller identity (see the provenance note above the hook) and a
  // pairing is an authority grant: submitting one unattended would let any page
  // that can open a URL attach an assistant of its choosing and have the
  // chooser connect to it. Prefilling retypes nothing, shows the user the host
  // they are about to pair with, and leaves the grant one click away.
  //
  // With nothing to submit the dialog explains the link instead. `legacy`
  // marks app versions whose connect dialog took a pasted pairing bundle; the
  // payload never crosses the bridge, so only the flag is read. The kind is
  // parked rather than the copy, so the dialog resolves it reactively.
  useBusSubscription("deeplink.connect", ({ url, code, legacy }) => {
    void ensureMainWindowVisible();
    const address = connectAddress(url, code);
    // Park before navigating so the chooser mounts with the dialog
    // already open (its auto-skip stands down while it is).
    useConnectDialogStore
      .getState()
      .openConnectDialog(
        address !== null
          ? { initialAddress: address }
          : { guidanceKind: legacy ? "legacy" : "generic" },
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
