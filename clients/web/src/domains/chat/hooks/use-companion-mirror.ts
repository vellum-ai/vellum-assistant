/**
 * `useCompanionMirror()` mirrors what the macOS companion surface cannot know
 * onto it: the assistant's name, whether a turn is in flight, and the state of
 * the sessions this window runs (a watch session, its summary, a keyboard
 * dictation).
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
 * **Pushed only when what the surface draws would change.** The store mints a
 * new snapshot object per stream event, most of which move nothing the surface
 * shows, and each push is an IPC message and a repaint of a window floating
 * over another app's work.
 */

import { useEffect } from "react";

import { assistantDisplayName } from "@/utils/assistant-display-name";
import { isPopoutWindowLifetime } from "@/runtime/popout-window";
import {
  clearCompanionWorking,
  setCompanionContext,
  setCompanionDictation,
} from "@/runtime/companion-surface";
import { supportsSightStream } from "@/lib/backwards-compat/use-supports-sight-stream";
import { supportsWatchCaptureTarget } from "@/lib/backwards-compat/watch-capture-target";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useConversationStore } from "@/stores/conversation-store";
import { isSending, useTurnStore } from "@/domains/chat/turn-store";
import {
  stopWatch,
  useWatchStore,
} from "@/domains/chat/watch/watch-controller";
import {
  isLiveVoiceSessionActive,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { useVoiceRecordingStore } from "@/domains/chat/voice/voice-recording-store";
import { useDictationOfferStore } from "@/domains/chat/voice/dictation-offer-store";
import { useWatchRetroStore } from "@/domains/chat/watch/watch-retro";
import { COMPANION_DICTATION_TAIL } from "@vellumai/ipc-contract";
import type {
  CompanionContext,
  CompanionDictating,
  CompanionDictationOffer,
} from "@vellumai/ipc-contract";

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
 * somewhere: the phase is reset outright by a conversation switch, and a send
 * into a draft conversation causes one when the server renames it on `ready`,
 * which also drops the draft's id from the optimistic mirror before the real id
 * joins it. Reading any one of them alone put the ring out in the middle of a
 * turn. Reading all three cannot, because a hole in one is covered by the
 * others, and nothing here can hold the ring on past the end: they all fall to
 * false on the same terminal event.
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

/** The assistant and this window's sessions, as the surface wants them. */
function currentContext(): CompanionContext {
  return {
    // Resolved here rather than on the surface, so the name cannot come out as
    // one wording in the app and another on the pill.
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
    // What that session reads, when it was aimed. Published with the flag for
    // the reason the count is: the frame main draws from it is a claim about
    // this session and no other.
    captureTarget: useWatchStore.getState().target,
    // Whether a session started here can be aimed at all, which is the
    // assistant's version and so this window's to know. The surface offers
    // its picker on a yes and starts the whole-screen session on anything
    // else. Re-read on every identity write, so it flips once the version
    // resolves and again on an assistant switch.
    watchTargets: supportsWatchCaptureTarget(
      useResolvedAssistantsStore.getState().activeAssistantId,
    ),
    // What the call is being shown, and whether it can be shown anything.
    // Published from here for the reason `captureTarget` is: the session the
    // frames land in lives in this window, and the surface draws the share as
    // on only once that session is one that takes them.
    screenShare: screenShareTarget(),
    screenShareEnabled: screenShareEnabled(),
    // What a keyboard dictation has got to. Published from here for the reason
    // `watching` is: the recording runs in this window, and while it runs the
    // surface is the only thing on screen to say so.
    dictating: dictatingPhase(),
    dictationText: dictationTail(),
    // Vellum's version of a dictation another app pasted, while offered.
    // Published from here for the reason `watchRetro` is: the words and the
    // way into the application they would go to are both this window's.
    dictationOffer: currentOffer(),
  };
}

function currentOffer(): CompanionDictationOffer | undefined {
  const { offer } = useDictationOfferStore.getState();
  if (offer === null) {
    return undefined;
  }
  if (offer.reason === "no-text-field") {
    return { reason: "no-text-field", id: offer.id, text: offer.text };
  }
  return {
    reason: "claimed",
    id: offer.id,
    app: offer.app.name,
    text: offer.text,
  };
}

/**
 * Whether the running call can be shown the screen: a session is up, on an
 * assistant that understands `sight_frame`, and has not latched the frame as
 * unsupported. The same conjunction the share hook runs, read as a snapshot.
 */
function screenShareEnabled(): boolean {
  const session = useLiveVoiceStore.getState();
  return (
    isLiveVoiceSessionActive(session.state) &&
    !session.sightFramesUnsupported &&
    supportsSightStream(session.assistantId)
  );
}

/**
 * What the call is being shown, or nothing. Withheld unless the share can
 * flow, so the surface never draws a share of a session that takes no frames.
 */
function screenShareTarget(): CompanionContext["screenShare"] {
  if (!screenShareEnabled()) {
    return undefined;
  }
  return useLiveVoiceStore.getState().screenShareTarget ?? undefined;
}

/**
 * The dictation the surface should be drawing, or nothing.
 *
 * Only a dictation the keyboard started: one begun from a control in the app is
 * already visible where it was begun, and the surface saying so as well would
 * be the same fact drawn twice. The store says which it was for as long as the
 * recording runs, which matters because the key itself is up again before a
 * short recording has finished starting. `processing` is the wait after the
 * keys come up, which is the stretch with nothing else on screen to explain
 * it.
 */
function dictatingPhase(): CompanionDictating | undefined {
  const { phase, hold } = useVoiceRecordingStore.getState();
  if (!hold) {
    return undefined;
  }
  switch (phase) {
    case "recording":
      return "listening";
    case "processing":
      return "transcribing";
    default:
      return undefined;
  }
}

/**
 * The end of what the running dictation has recognised, bounded.
 *
 * The end rather than the start: the surface draws one line, and the words a
 * speaker wants to check are the ones they just said. Empty when nothing is
 * being dictated, so the field says nothing rather than something stale.
 */
function dictationTail(): string {
  if (dictatingPhase() === undefined) {
    return "";
  }
  const interim = useVoiceRecordingStore.getState().interimTranscript;
  return interim.slice(-COMPANION_DICTATION_TAIL);
}

/** The share as the surface would draw it, as one comparable value. */
function screenShareKey(): string {
  const target = screenShareTarget();
  const enabled = screenShareEnabled();
  return `${enabled ? "on" : "off"}:${target === undefined ? "" : `${target.kind}:${target.kind === "display" ? target.displayId : target.windowId}`}`;
}

/** Whether two targets name the same display or window, absence included. */
function sameTarget(
  a: CompanionContext["captureTarget"],
  b: CompanionContext["captureTarget"],
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.kind === "display"
    ? b.kind === "display" && a.displayId === b.displayId
    : b.kind === "window" && a.windowId === b.windowId;
}

/**
 * The app name an offer carries, or undefined where its reason has none.
 * Named so the comparison below can read one field off both shapes without
 * narrowing each side first.
 */
function offerApp(
  offer: CompanionDictationOffer | undefined,
): string | undefined {
  return offer?.reason === "claimed" ? offer.app : undefined;
}

/** Whether two payloads would draw the same surface. */
function sameContext(a: CompanionContext, b: CompanionContext): boolean {
  return (
    a.assistantName === b.assistantName &&
    a.working === b.working &&
    a.watching === b.watching &&
    a.watchRetro === b.watchRetro &&
    a.captureCount === b.captureCount &&
    sameTarget(a.captureTarget, b.captureTarget) &&
    a.watchTargets === b.watchTargets &&
    sameTarget(a.screenShare, b.screenShare) &&
    a.screenShareEnabled === b.screenShareEnabled &&
    a.dictating === b.dictating &&
    a.dictationText === b.dictationText &&
    a.dictationOffer?.id === b.dictationOffer?.id &&
    a.dictationOffer?.reason === b.dictationOffer?.reason &&
    offerApp(a.dictationOffer) === offerApp(b.dictationOffer) &&
    a.dictationOffer?.text === b.dictationOffer?.text
  );
}

export function useCompanionMirror(): void {
  useEffect(() => {
    // **The main window and no other.** `RootLayout` mounts in pop-out thread
    // windows too, and every pop-out would publish its own reading over the
    // last one's, so the surface would show whichever window wrote most
    // recently. The sessions it draws live in the main window, so that is the
    // one that publishes.
    if (isPopoutWindowLifetime()) {
      return;
    }

    let pushed: CompanionContext | null = null;
    // What the last computed context said about the turn, so the subscription
    // below can tell a flip from the store merely being written.
    let working = isWorking();
    // The same, for the dictation: the store below moves many times a second
    // while a microphone is open, and only two of those writes change what the
    // surface draws.
    let dictating = dictatingPhase();
    // The words that came with it. Declared beside the phase because `sync`
    // writes both, and `sync` runs before the subscriptions are set up.
    let dictationText = dictationTail();

    const sync = (): void => {
      const context = currentContext();
      working = context.working;
      dictating = context.dictating;
      dictationText = context.dictationText ?? "";
      if (pushed !== null && sameContext(pushed, context)) {
        return;
      }
      pushed = context;
      setCompanionContext(context);
    };

    // A turn can already be running when this mounts, and the surface outlives
    // every route in the app, so it is caught up here rather than waiting for
    // the next store write.
    sync();
    // The session store carries `snapshot.processing`, which is one leg of the
    // working flag, and it is written on every streamed delta. Gated on the
    // flag flipping rather than on the store being written, since almost none
    // of those writes move anything the surface draws.
    const onMaybeFlipped = (): void => {
      if (isWorking() === working) {
        return;
      }
      sync();
    };
    const unsubscribeSession = useChatSessionStore.subscribe(onMaybeFlipped);
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
    // conversation store moves for plenty the surface never draws.
    const unsubscribeWatch = useWatchStore.subscribe(sync);
    // The summary's own store, for the same reason and on the same terms: it
    // moves on the stop edge, on the runtime's announcement, and on the user
    // answering, and nothing else here reports any of those.
    const unsubscribeWatchRetro = useWatchRetroStore.subscribe(sync);
    // The call the share belongs to. Gated on what the surface draws of it
    // rather than on the store being written, since the store moves on every
    // amplitude sample while a call runs.
    let shareKey = screenShareKey();
    const onShareMaybeFlipped = (): void => {
      const next = screenShareKey();
      if (next === shareKey) {
        return;
      }
      shareKey = next;
      sync();
    };
    const unsubscribeShare = useLiveVoiceStore.subscribe(onShareMaybeFlipped);
    const unsubscribeOffer = useDictationOfferStore.subscribe(sync);
    // The microphone a held key opened. Nothing above reports it: the
    // recording is this window's, it starts and stops from the keyboard rather
    // than from anything the conversation knows about, and while it runs the
    // surface is the only thing on screen saying so.
    //
    // Gated on the phase changing rather than on the store being written. It
    // carries the live audio level and the interim transcript, so it moves
    // continuously through a recording, and only two of those writes change
    // what the surface draws.
    const onDictationMaybeFlipped = (): void => {
      if (dictatingPhase() !== dictating) {
        sync();
        return;
      }
      // The words moved but nothing else did. Corrected in place rather than
      // rebuilt: `sync` reselects and remaps the whole tail, and a recogniser
      // revises its guess several times a second.
      const nextText = dictationTail();
      if (nextText === dictationText) {
        return;
      }
      dictationText = nextText;
      if (pushed !== null) {
        pushed = { ...pushed, dictationText: nextText };
      }
      setCompanionDictation(dictating, nextText);
    };
    const unsubscribeDictation = useVoiceRecordingStore.subscribe(
      onDictationMaybeFlipped,
    );
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
      unsubscribeShare();
      unsubscribeOffer();
      unsubscribeDictation();
      // Nothing is left to report a turn ending, so the last thing this does is
      // stop claiming one is running. The name is left standing: it is a record
      // of whose surface this is, and the surface is still on screen.
      clearCompanionWorking();
    };
  }, []);
}
