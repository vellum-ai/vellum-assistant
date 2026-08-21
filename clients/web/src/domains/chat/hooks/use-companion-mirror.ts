/**
 * `useCompanionMirror()` mirrors what the macOS companion surface cannot know
 * onto it: the assistant's name, the tail of the open conversation, and whether
 * a watch session is running. Together they are what let an exchange started
 * from the surface's Type option be read on the surface, instead of by going
 * back to an app the user deliberately did not go back to.
 *
 * The same shape as {@link useLiveActivityMirror}, and for the same reason: the
 * surface is its own renderer with no assistant and no conversation in it, so
 * the window that holds them publishes, main holds the snapshot, and the
 * surface draws it. Off Electron the sink no-ops, so this hook needs no
 * platform branch of its own.
 *
 * **Everything runs inside an effect**, reading the stores through
 * subscriptions rather than reactive selectors. A streaming turn writes to the
 * chat-session store on every delta, and a selector here would re-render the
 * layout this is mounted in on each one.
 *
 * **Pushed only when the drawn card would change.** The store mints a new
 * snapshot object per stream event, most of which move no text the card shows,
 * and each push is an IPC message and a repaint of a window floating over
 * another app's work.
 */

import { useEffect } from "react";

import { assistantDisplayName } from "@/utils/assistant-display-name";
import { isPopoutWindowLifetime } from "@/runtime/popout-window";
import { messagePlainText } from "@/domains/chat/utils/message-plain-text";
import { selectTranscriptMessages } from "@/domains/chat/transcript/select-transcript-messages";
import {
  clearCompanionWorking,
  setCompanionContext,
} from "@/runtime/companion-surface";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useConversationStore } from "@/stores/conversation-store";
import { isSending, useTurnStore } from "@/domains/chat/turn-store";
import {
  stopWatch,
  useWatchStore,
} from "@/domains/chat/watch/watch-controller";
import { useWatchRetroStore } from "@/domains/chat/watch/watch-retro";
import type { CompanionContext, CompanionTurn } from "@vellumai/ipc-contract";
import type { DisplayMessage } from "@/domains/chat/types/types";

/**
 * How many turns cross the bridge.
 *
 * The card scrolls, so this is how far back the user can read on the surface
 * before they have to go to the app for the rest. Bounded rather than whole,
 * because a floating panel is not where anyone reads a long conversation and
 * the whole transcript would cross this bridge on every streamed delta.
 */
const TAIL = 20;

/**
 * Rows the card has no way to render, and would be wrong to.
 *
 * Daemon-injected lifecycle notifications and status cards are not speech: the
 * transcript suppresses them or draws them as system notices, and the card has
 * only two idioms, a user bubble and assistant text. A row with no text at all
 * is a tool call or a surface, which is activity rather than something said.
 */
function isSpeech(message: DisplayMessage): boolean {
  return (
    message.isSubagentNotification !== true &&
    message.isAcpNotification !== true &&
    message.isBackgroundEventNotification !== true &&
    message.isSystemCard !== true &&
    messagePlainText(message) !== ""
  );
}

/**
 * Whether a turn is in flight, from the press until the response is done.
 *
 * **The union of the three answers the app already trusts**, because no single
 * one of them covers the whole turn:
 *
 * - `snapshot.processing` is the daemon's own flag, patched true on
 *   `assistant_turn_start` and false on the terminal event. It is the only one
 *   that spans the long middle of a turn, where the assistant is running tools
 *   and nothing is streaming yet.
 * - `processingConversationIds` is the client's optimistic mirror, set in the
 *   same tick as the send. It covers the window before the daemon has said
 *   anything at all.
 * - `isSending(phase)` is the local state machine, which moves first of all.
 *
 * Deliberately a union rather than a choice. Each of these has a hole
 * somewhere: the phase is reset outright by a conversation switch, and the
 * surface's own composer causes one by sending into a draft conversation the
 * server renames on `ready`, which also drops the draft's id from the
 * optimistic mirror before the real id joins it. Reading any one of them alone
 * put the ring out in the middle of a turn. Reading all three cannot, because
 * a hole in one is covered by the others, and nothing here can hold the ring on
 * past the end: they all fall to false on the same terminal event.
 *
 * No phase is excluded. Thinking, a tool running, and waiting on an answer are
 * one turn as far as the surface is concerned, and a ring that dropped out
 * between them would be reporting the shape of the turn rather than that there
 * is one.
 *
 * Unscoped to a conversation on purpose. The surface is the assistant's
 * presence on the desktop rather than a view of one thread, so a turn arriving
 * from Slack or a phone call counts the same as one typed here.
 */
const isWorking = (): boolean =>
  useChatSessionStore.getState().snapshot?.processing === true ||
  useConversationStore.getState().processingConversationIds.size > 0 ||
  isSending(useTurnStore.getState().phase);

/** The assistant and the conversation's tail, as the card wants them. */
function currentContext(): CompanionContext {
  const { snapshot, optimisticSends } = useChatSessionStore.getState();
  // The same union the transcript renders, through the read seam
  // `selectTranscriptMessages` exists to be: a message sent from the surface
  // shows up as an optimistic row long before the server echoes it, and a card
  // that waited for the echo would sit blank through the part of the exchange
  // the user is actually watching.
  const messages = selectTranscriptMessages(
    snapshot?.messages ?? [],
    optimisticSends,
  );
  return {
    // Resolved here rather than on the surface, so the placeholder cannot come
    // out as one wording in the app and another on the pill.
    assistantName: assistantDisplayName(
      useAssistantIdentityStore.getState().name,
    ),
    working: isWorking(),
    // The session lives in this window, and the surface is only where it was
    // asked for, so this is the one side that can say whether it is running.
    // What the surface turns into its capture indicator.
    watching: useWatchStore.getState().watching,
    // Where the last session's summary has got to. Published from here for the
    // same reason `watching` is, and with one more step behind it: the runtime
    // announces the retrospective on this window's event stream, which the
    // surface's own renderer is not subscribed to.
    watchRetro: useWatchRetroStore.getState().retro?.phase,
    // The session's screen reads, counted. A step in this is the surface's
    // only evidence that a capture happened, so it is published with the flag
    // rather than beside it: the two are one fact about one session, and a
    // count that arrived a push apart from the flag it belongs to would mark a
    // capture against a session the surface has already stopped drawing.
    captureCount: useWatchStore.getState().captureCount,
    turns: messages
      .filter(isSpeech)
      .slice(-TAIL)
      .map((message): CompanionTurn => ({
        role:
          message.role === "user" ? ("user" as const) : ("assistant" as const),
        text: messagePlainText(message),
      })),
  };
}

/** Whether two payloads would draw the same card. */
function sameContext(a: CompanionContext, b: CompanionContext): boolean {
  return (
    a.assistantName === b.assistantName &&
    a.working === b.working &&
    a.watching === b.watching &&
    a.watchRetro === b.watchRetro &&
    a.captureCount === b.captureCount &&
    a.turns.length === b.turns.length &&
    a.turns.every(
      (turn, index) =>
        turn.role === b.turns[index]?.role &&
        turn.text === b.turns[index]?.text,
    )
  );
}

export function useCompanionMirror(): void {
  useEffect(() => {
    // **The main window and no other.** `RootLayout` mounts in pop-out thread
    // windows too, and each one has a different conversation open, so every
    // pop-out would publish its own tail over the last one's and the card would
    // show whichever window wrote most recently. The surface's Type sends
    // through `dispatchToMain`, so the conversation it draws has to be the one
    // that window holds.
    if (isPopoutWindowLifetime()) {
      return;
    }

    let pushed: CompanionContext | null = null;
    // What the last computed context said about the turn, so the subscription
    // below can tell a flip from the store merely being written.
    let working = isWorking();

    const sync = (): void => {
      const context = currentContext();
      working = context.working;
      if (pushed !== null && sameContext(pushed, context)) {
        return;
      }
      pushed = context;
      setCompanionContext(context);
    };

    // A conversation can already be loaded when this mounts, and the surface
    // outlives every route in the app, so the card is caught up here rather
    // than waiting for the next store write.
    sync();
    // `sync` recomputes the flag along with the tail, so the session store's
    // own writes carry `snapshot.processing` changes without further wiring.
    const unsubscribeSession = useChatSessionStore.subscribe(sync);
    // A turn can begin and end without moving a single row the card draws: a
    // reply still being thought about has no text yet, and one that finishes
    // leaves its last text exactly where it already was. So the flag needs a
    // subscription of its own rather than riding the transcript's.
    //
    // Gated on the flag flipping rather than on the store being written, since
    // the conversation store moves for plenty the card does not draw and `sync`
    // reselects and remaps the whole tail on every call.
    const onMaybeFlipped = (): void => {
      if (isWorking() === working) {
        return;
      }
      sync();
    };
    const unsubscribeProcessing =
      useConversationStore.subscribe(onMaybeFlipped);
    const unsubscribeTurn = useTurnStore.subscribe(onMaybeFlipped);
    // The name arrives on its own schedule, after the identity resolves and
    // again on every assistant switch, so it needs a subscription of its own.
    const unsubscribeIdentity = useAssistantIdentityStore.subscribe(sync);
    // The watch session starts and ends from outside every store above it: the
    // command arrives from the companion surface, and the session can also end
    // on its own when the socket drops. Only its own store reports either.
    //
    // Straight to `sync` rather than through a flip gate like the one above,
    // because this store is written on the session's two edges and once per
    // screen read, all three of which the surface draws, where the
    // conversation store moves for plenty the card never draws.
    const unsubscribeWatch = useWatchStore.subscribe(sync);
    // The summary's own store, for the same reason and on the same terms: it
    // moves on the stop edge, on the runtime's announcement, and on the user
    // answering, and nothing else here reports any of those.
    const unsubscribeWatchRetro = useWatchRetroStore.subscribe(sync);
    return () => {
      // **Before the unsubscribes**, so the flip this causes is still published
      // and the surface does not keep a capture indicator over a machine
      // nothing is reading any more.
      //
      // Ended rather than merely un-drawn, which is the difference between this
      // and the working flag below. The microphone and the socket are in this
      // window: a layout going away takes the only thing that could stop them
      // with it, so the session goes with the layout.
      stopWatch();
      unsubscribeSession();
      unsubscribeProcessing();
      unsubscribeTurn();
      unsubscribeIdentity();
      unsubscribeWatch();
      unsubscribeWatchRetro();
      // Nothing is left to report a turn ending, so the last thing this does is
      // stop claiming one is running. The tail and the name are left standing:
      // they are a record of what was said, and the surface is still the place
      // to read it.
      clearCompanionWorking();
    };
  }, []);
}
