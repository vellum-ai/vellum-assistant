/**
 * `useCompanionMirror()` mirrors what the macOS companion surface cannot know
 * onto it: the assistant's name and the tail of the open conversation. Together
 * they are what let an exchange started from the surface's Type option be read
 * on the surface, instead of by going back to an app the user deliberately did
 * not go back to.
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
import { setCompanionContext } from "@/runtime/companion-surface";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
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
    turns: messages
      .filter(isSpeech)
      .slice(-TAIL)
      .map(
        (message): CompanionTurn => ({
          role:
            message.role === "user" ? ("user" as const) : ("assistant" as const),
          text: messagePlainText(message),
        }),
      ),
  };
}

/** Whether two payloads would draw the same card. */
function sameContext(a: CompanionContext, b: CompanionContext): boolean {
  return (
    a.assistantName === b.assistantName &&
    a.turns.length === b.turns.length &&
    a.turns.every(
      (turn, index) =>
        turn.role === b.turns[index]?.role && turn.text === b.turns[index]?.text,
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

    const sync = (): void => {
      const context = currentContext();
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
    const unsubscribeSession = useChatSessionStore.subscribe(sync);
    // The name arrives on its own schedule, after the identity resolves and
    // again on every assistant switch, so it needs a subscription of its own.
    const unsubscribeIdentity = useAssistantIdentityStore.subscribe(sync);
    return () => {
      unsubscribeSession();
      unsubscribeIdentity();
    };
  }, []);
}
