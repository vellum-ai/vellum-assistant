/**
 * A send entered after the user moved to another thread.
 *
 * `submitMessage` awaits before it calls in here: the composer resolves the
 * Eyes camera frame, and an edited message reposts through an undo first. Both
 * hold a call that closed over the conversation the click happened in, and a
 * conversation switch during either lands the send in this hook with the
 * session store already belonging to somewhere else.
 *
 * The message still goes to the conversation it was written in, because the
 * POST targets the id this call carries. What must not happen is the send
 * writing into the stores that describe the ONE thread on screen: the
 * optimistic row and the queue FIFO, which nothing would take back out (a
 * switch clears them, and these arrive after that); the turn phase, whose
 * matching `acceptSend` is scope-checked and would leave the composer disabled;
 * and the interactive surfaces, which belong to the thread the user is reading.
 *
 * Driven against a spied daemon client rather than `mock.module`, so the module
 * registry stays clean for the sibling send suites.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import { useEffect, type ReactNode } from "react";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useComposerStore } from "@/domains/chat/composer-store";
import { useDoctorHandoffStore } from "@/stores/doctor-handoff-store";
import { useSendMessage } from "@/domains/chat/hooks/use-send-message";
import {
  INITIAL_TURN_STATE,
  isSending,
  useTurnStore,
} from "@/domains/chat/turn-store";
import type { EphemeralMetaResult } from "@/domains/chat/types/types";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/** The thread the send was written in. */
const SEND_CONVERSATION = "conv-written-in";
/** The thread the user moved to while the send was awaiting. */
const OPEN_CONVERSATION = "conv-now-open";

let capturedBody: Record<string, unknown> | null = null;
/** What the daemon answers the send POST with. Reset to a plain accept. */
let postResponse: Record<string, unknown> = {};
const originalPost = daemonClient.post;

/** The daemon accepted the message and ran it directly (no queue). */
const ACCEPTED_DIRECTLY = {
  accepted: true,
  conversationId: SEND_CONVERSATION,
  messageId: "m1",
};

/** The daemon parked the message behind the turn already running. */
const ACCEPTED_QUEUED = {
  accepted: true,
  conversationId: SEND_CONVERSATION,
  queued: true,
  requestId: "request-1",
};

/**
 * The turn store as a phase plus the turn it belongs to. Both matter: a stale
 * send claiming the store swaps the id out from under the turn the open thread
 * is actually running, which the phase alone would not show.
 */
/**
 * The text parked for `key`, read back the way the composer reads it: through
 * the restore that runs when that conversation is opened.
 */
function draftFor(key: string): string {
  useComposerStore.setState({ input: "" });
  useDoctorHandoffStore.setState({ pendingPrompt: null });
  currentLocation = START_LOCATION;
  useComposerStore.getState().restoreDraftIfEmpty(key);
  return useComposerStore.getState().input;
}

/**
 * A daemon that moves the user to another thread while the POST is in flight,
 * which is the longest window a send spends with its answer still to come.
 */
function switchWhileAnswering(data: Record<string, unknown>) {
  daemonClient.post = mock(
    async (options: { body?: Record<string, unknown> }) => {
      capturedBody = options.body ?? null;
      useConversationStore
        .getState()
        .setActiveConversationId(OPEN_CONVERSATION);
      return {
        data,
        error: null,
        response: new Response(null, { status: 200 }),
      };
    },
  ) as typeof daemonClient.post;
}

/** A turn belonging to whichever thread the user opened. */
const OPEN_THREAD_ANSWERING = {
  phase: "streaming" as const,
  activeTurnId: "open-turn",
};

function turnState() {
  const { phase, activeTurnId } = useTurnStore.getState();
  return { phase, activeTurnId };
}

/**
 * The conversation the POST targeted. The id rides in the body under one of two
 * wire fields depending on the assistant's version, and which one it picked is
 * not what these tests are about.
 */
function postedConversationId(): unknown {
  return capturedBody?.conversationId ?? capturedBody?.conversationKey;
}

const queryClient = new QueryClient();

/** Where the router currently stands, recorded rather than mocked. */
let currentLocation = "";
const START_LOCATION = "/assistant";

function LocationProbe() {
  const location = useLocation();
  const here = `${location.pathname}${location.search}`;
  // Recorded from an effect rather than during render: a render body may not
  // write to anything outside itself.
  useEffect(() => {
    currentLocation = here;
  }, [here]);
  return null;
}

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter initialEntries={[START_LOCATION]}>
      <QueryClientProvider client={queryClient}>
        {children}
        <LocationProbe />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

/**
 * The hook as the composer holds it: bound to the conversation the click
 * happened in. A switch during the await moves the stores, not this.
 */
function renderSendFor(conversationId: string) {
  const cancelReconciliation = mock(() => {});
  const props = {
    assistantId: "assistant-1",
    activeConversationId: conversationId,
    diskPressureChatBlockReason: null,
    uiContextRef: { current: null },
    pendingOnboardingContextRef: { current: null },
    onboardingDraftConversationIdRef: { current: null },
    startReconciliationLoop: () => {},
    cancelReconciliation,
    refreshConversations: async () => {},
  };
  return {
    ...renderHook(() => useSendMessage(props), { wrapper: Wrapper }),
    cancelReconciliation,
  };
}

/**
 * A daemon whose POST throws rather than answering, optionally moving the user
 * to another thread on the way out. A thrown send is the one failure that skips
 * `sendMessageViaStream`'s own scope classification and lands in the outer
 * catch instead.
 */
function throwWhileAnswering(options: { switchFirst?: boolean } = {}) {
  daemonClient.post = mock(async () => {
    if (options.switchFirst) {
      useConversationStore
        .getState()
        .setActiveConversationId(OPEN_CONVERSATION);
      // The thread they opened has an answer of its own running.
      useTurnStore.setState(OPEN_THREAD_ANSWERING);
    }
    throw new Error("network down");
  }) as typeof daemonClient.post;
}

beforeEach(() => {
  capturedBody = null;
  queryClient.clear();
  useConversationStore.getState().reset();
  useTurnStore.setState(INITIAL_TURN_STATE);
  useChatSessionStore.setState({
    optimisticSends: [],
    error: null,
    pendingQueuedMessageIds: [],
    ephemeralMetaResults: [],
    contextWindowUsage: null,
  });
  useResolvedAssistantsStore.getState().setActiveAssistantId("assistant-1");
  // The draft map is module state shared across tests; reloading it for the
  // assistant from an empty localStorage is how the store itself resets it.
  localStorage.clear();
  useComposerStore.getState().loadAssistantDrafts("assistant-1");
  useComposerStore.setState({ input: "" });

  postResponse = ACCEPTED_DIRECTLY;

  daemonClient.post = mock(
    async (options: { body?: Record<string, unknown> }) => {
      capturedBody = options.body ?? null;
      return {
        data: postResponse,
        error: null,
        response: new Response(null, { status: 200 }),
      };
    },
  ) as typeof daemonClient.post;
});

afterEach(() => {
  daemonClient.post = originalPost;
  cleanup();
});

describe("useSendMessage: a send whose thread is no longer open", () => {
  test("paints no optimistic row in the transcript that is open now", async () => {
    // GIVEN the user switched threads while the send was awaiting
    useConversationStore.getState().setActiveConversationId(OPEN_CONVERSATION);
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("what am I holding?");
    });

    // THEN the row it would have painted is absent from the session store the
    // open thread renders from.
    expect(useChatSessionStore.getState().optimisticSends).toEqual([]);
    // AND the message still went to the thread it was written in.
    expect(postedConversationId()).toBe(SEND_CONVERSATION);
  });

  test("the queue path leaves the open transcript alone too", async () => {
    // The queue path posts and returns without ever reaching the send's
    // post-POST scope check, so its row would otherwise stay put for good.
    useTurnStore.setState({ phase: "streaming", activeTurnId: "turn-1" });
    useConversationStore.getState().setActiveConversationId(OPEN_CONVERSATION);
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("queue this one");
    });

    expect(useChatSessionStore.getState().optimisticSends).toEqual([]);
    // The pending FIFO is held in the same store, and an ack for a thread it
    // does not describe would bind to the next visible send's row.
    expect(useChatSessionStore.getState().pendingQueuedMessageIds).toEqual([]);
    expect(postedConversationId()).toBe(SEND_CONVERSATION);
  });

  test("leaves the open thread's turn phase alone", async () => {
    // `requestSend` puts the turn store into a submitting phase, and the
    // matching `acceptSend` is scope-checked, so a stale send that reached it
    // would leave the open thread submitting forever with its composer
    // disabled and no turn behind it.
    useConversationStore.getState().setActiveConversationId(OPEN_CONVERSATION);
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("what am I holding?");
    });

    expect(isSending(useTurnStore.getState().phase)).toBe(false);
    expect(useTurnStore.getState().phase).toBe(INITIAL_TURN_STATE.phase);
  });

  test("leaves the open thread's interactive surfaces standing", async () => {
    // A send supersedes the surfaces of the thread it is sent into. A stale
    // one has nothing on screen to supersede, so a pending confirmation the
    // user has not answered in the thread they just opened must survive it.
    useConversationStore.getState().setActiveConversationId(OPEN_CONVERSATION);
    const standingCard: EphemeralMetaResult = {
      id: "meta-1",
      kind: "info",
      text: "all good",
    };
    useChatSessionStore.setState({ ephemeralMetaResults: [standingCard] });
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("what am I holding?");
    });

    expect(useChatSessionStore.getState().ephemeralMetaResults).toHaveLength(1);
  });

  test("the row is painted as usual while the thread is still open", async () => {
    useConversationStore.getState().setActiveConversationId(SEND_CONVERSATION);
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("still here");
    });

    const rows = useChatSessionStore.getState().optimisticSends;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textSegments).toEqual(["still here"]);
  });
});

/**
 * The queue branch is reachable for a stale send because `willQueue` reads the
 * OPEN thread's phase: a thread answering on screen sends every message written
 * anywhere down this path, including one whose own conversation was idle. Its
 * responses then carry writes that describe the thread on screen.
 */
describe("useSendMessage: a stale send through the queue branch", () => {
  /** The open thread is mid-answer, which is what puts a send on this path. */
  const OPEN_THREAD_TURN = {
    phase: "streaming" as const,
    activeTurnId: "open-turn",
  };

  beforeEach(() => {
    useConversationStore.getState().setActiveConversationId(OPEN_CONVERSATION);
    useTurnStore.setState(OPEN_THREAD_TURN);
  });

  test("a directly-processed response leaves the open thread's turn alone", async () => {
    // GIVEN the send's own thread turned out to be idle, so the daemon ran the
    // message rather than queueing it. The fallback that follows claims a turn.
    postResponse = ACCEPTED_DIRECTLY;
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("what am I holding?");
    });

    // THEN the turn the open thread is streaming is still its own.
    expect(turnState()).toEqual(OPEN_THREAD_TURN);
    expect(postedConversationId()).toBe(SEND_CONVERSATION);
  });

  test("a queued response leaves the open thread's turn and FIFO alone", async () => {
    postResponse = ACCEPTED_QUEUED;
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("queue this one");
    });

    expect(turnState()).toEqual(OPEN_THREAD_TURN);
    expect(useChatSessionStore.getState().pendingQueuedMessageIds).toEqual([]);
    // The mapping binds a deletion broadcast to a rendered row, and this send
    // has none on screen to bind to.
    expect(useChatSessionStore.getState().requestIdToMessageId.size).toBe(0);
  });

  test("a failed queue POST raises no error over the open thread", async () => {
    postResponse = {};
    daemonClient.post = mock(async () => ({
      data: null,
      error: { detail: "nope" },
      response: new Response(null, { status: 500 }),
    })) as typeof daemonClient.post;
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("doomed");
    });

    expect(useChatSessionStore.getState().error).toBeNull();
    expect(turnState()).toEqual(OPEN_THREAD_TURN);
  });

  test("the same response drives the turn while the thread is still open", async () => {
    // The control: on screen, the fallback claims its turn exactly as before.
    useConversationStore.getState().setActiveConversationId(SEND_CONVERSATION);
    postResponse = ACCEPTED_DIRECTLY;
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("still here");
    });

    expect(useTurnStore.getState().activeTurnId).not.toBe(
      OPEN_THREAD_TURN.activeTurnId,
    );
  });
});

/**
 * A send that fails after the user has moved on has nowhere on screen to report
 * itself: the streaming path classifies it `ignored` and the queue path's
 * banner is scoped to the thread the failure happened in. The text still has to
 * survive, so it goes back to its own conversation's draft slot and is handed
 * over the next time that thread is opened.
 */
describe("useSendMessage: a stale send that fails", () => {
  /** A daemon that refuses the POST. */
  function refusePost() {
    daemonClient.post = mock(async () => ({
      data: null,
      error: { detail: "nope" },
      response: new Response(null, { status: 500 }),
    })) as typeof daemonClient.post;
  }

  beforeEach(() => {
    useConversationStore.getState().setActiveConversationId(OPEN_CONVERSATION);
    refusePost();
  });

  test("the streaming path parks the text in its own thread's draft", async () => {
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("the one that got away");
    });

    expect(draftFor(SEND_CONVERSATION)).toBe("the one that got away");
    // Never into the thread the user is actually reading.
    expect(draftFor(OPEN_CONVERSATION)).toBe("");
  });

  test("the queue path parks it too", async () => {
    useTurnStore.setState({ phase: "streaming", activeTurnId: "open-turn" });
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("queued and lost");
    });

    expect(draftFor(SEND_CONVERSATION)).toBe("queued and lost");
    expect(draftFor(OPEN_CONVERSATION)).toBe("");
  });

  test("a draft already waiting in that thread is left alone", async () => {
    // Written after the send left, so it is the newer of the two and the one
    // the user last saw in that composer.
    useComposerStore.getState().saveDraft(SEND_CONVERSATION, "typed later");
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("the one that got away");
    });

    expect(draftFor(SEND_CONVERSATION)).toBe("typed later");
  });

  test("a hidden send has no user text to give back", async () => {
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("scripted kickoff", [], {
        hidden: true,
      });
    });

    expect(draftFor(SEND_CONVERSATION)).toBe("");
  });

  test("an on-screen failure is unchanged: it banners rather than parks", async () => {
    useConversationStore.getState().setActiveConversationId(SEND_CONVERSATION);
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("right here");
    });

    expect(useChatSessionStore.getState().error).not.toBeNull();
    expect(draftFor(SEND_CONVERSATION)).toBe("");
  });
});

/**
 * The switch lands mid-POST rather than before the send: on entry this thread
 * IS the one on screen, so every pre-POST write runs as it should, and only the
 * response writes have to notice that the screen moved under them.
 */
describe("useSendMessage: a switch during the POST", () => {
  const OPEN_THREAD_TURN = {
    phase: "streaming" as const,
    activeTurnId: "open-turn",
  };

  beforeEach(() => {
    // On screen at entry. The stub moves the user mid-flight.
    useConversationStore.getState().setActiveConversationId(SEND_CONVERSATION);
  });

  test("a directly-processed response does not claim the newly opened turn", async () => {
    // `willQueue` is read pre-POST, so a streaming thread puts this send on the
    // queue path; the daemon then reports it ran the message straight away.
    useTurnStore.setState(OPEN_THREAD_TURN);
    switchWhileAnswering(ACCEPTED_DIRECTLY);
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("what am I holding?");
    });

    expect(turnState()).toEqual(OPEN_THREAD_TURN);
  });

  test("a failure raises no banner and parks the text instead", async () => {
    daemonClient.post = mock(async () => {
      useConversationStore
        .getState()
        .setActiveConversationId(OPEN_CONVERSATION);
      return {
        data: null,
        error: { detail: "nope" },
        response: new Response(null, { status: 500 }),
      };
    }) as typeof daemonClient.post;
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("the one that got away");
    });

    // On screen when it started, off screen when it failed: the banner would
    // land on the wrong thread, so the text goes to its own thread's draft.
    expect(useChatSessionStore.getState().error).toBeNull();
    expect(draftFor(SEND_CONVERSATION)).toBe("the one that got away");
  });

  test("a queue-branch failure banners nowhere and parks the text", async () => {
    // The same window on the path that posts for itself: `willQueue` was read
    // before the POST, so this send is on the queue branch when the switch
    // lands and its own failure handling has to notice.
    useTurnStore.setState(OPEN_THREAD_TURN);
    daemonClient.post = mock(async () => {
      useConversationStore
        .getState()
        .setActiveConversationId(OPEN_CONVERSATION);
      return {
        data: null,
        error: { detail: "nope" },
        response: new Response(null, { status: 500 }),
      };
    }) as typeof daemonClient.post;
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("queued and lost");
    });

    expect(useChatSessionStore.getState().error).toBeNull();
    expect(draftFor(SEND_CONVERSATION)).toBe("queued and lost");
  });

  test("a queued response leaves the newly opened thread's mapping empty", async () => {
    useTurnStore.setState(OPEN_THREAD_TURN);
    switchWhileAnswering(ACCEPTED_QUEUED);
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("queue this one");
    });

    expect(useChatSessionStore.getState().requestIdToMessageId.size).toBe(0);
  });
});

/**
 * A local meta command runs against its own conversation whatever happens, but
 * its card and context readout describe the thread on screen. The serialized
 * send chain can hold a `/status` behind a pending camera frame, so its answer
 * can arrive after the user has moved on.
 */
describe("useSendMessage: a local command answering after a switch", () => {
  const META_ANSWER = { kind: "info", text: "all good" };

  test("draws no card in the thread that is open now", async () => {
    useConversationStore.getState().setActiveConversationId(SEND_CONVERSATION);
    switchWhileAnswering(META_ANSWER);
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("/status");
    });

    expect(useChatSessionStore.getState().ephemeralMetaResults).toEqual([]);
  });

  test("draws it as usual when its own thread is still open", async () => {
    useConversationStore.getState().setActiveConversationId(SEND_CONVERSATION);
    postResponse = META_ANSWER;
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("/status");
    });

    const cards = useChatSessionStore.getState().ephemeralMetaResults;
    expect(cards).toHaveLength(1);
    expect(cards[0]?.text).toBe("all good");
  });
});

/**
 * A POST that throws instead of answering. The outer catch is the only handler
 * such a send reaches, so everything the scoped paths do has to happen there
 * too: idle the turn only for the thread on screen, and hand the text back to
 * its own conversation otherwise.
 */
describe("useSendMessage: a send whose POST throws", () => {
  test("off screen it idles no turn, banners nothing, and parks the text", async () => {
    useConversationStore.getState().setActiveConversationId(SEND_CONVERSATION);
    throwWhileAnswering({ switchFirst: true });
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("the one that got away");
    });

    // The answer the user is watching is still running.
    expect(turnState()).toEqual(OPEN_THREAD_ANSWERING);
    expect(useChatSessionStore.getState().error).toBeNull();
    expect(draftFor(SEND_CONVERSATION)).toBe("the one that got away");
  });

  test("on screen it behaves as it always has", async () => {
    useConversationStore.getState().setActiveConversationId(SEND_CONVERSATION);
    throwWhileAnswering();
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("right here");
    });

    expect(useChatSessionStore.getState().error).not.toBeNull();
    // `onStreamError` ran: the turn is idled and its id dropped.
    expect(turnState()).toEqual({ phase: "idle", activeTurnId: null });
    // Nothing parked, because the banner carries the failure.
    expect(draftFor(SEND_CONVERSATION)).toBe("");
  });

  test("the queue branch's own catch parks it too", async () => {
    // `willQueue` is read pre-POST, so a thread already answering puts this
    // send on the queue path; its catch is a separate handler from the one
    // above and needs the same split.
    useConversationStore.getState().setActiveConversationId(SEND_CONVERSATION);
    useTurnStore.setState({ phase: "streaming", activeTurnId: "own-turn" });
    throwWhileAnswering({ switchFirst: true });
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("queued and thrown");
    });

    expect(useChatSessionStore.getState().error).toBeNull();
    expect(draftFor(SEND_CONVERSATION)).toBe("queued and thrown");
  });
});

/**
 * The reconciliation timer is the open thread's delivery backstop below the
 * events-tail floor. A send cancels it to say "a turn is starting here"; a send
 * that is no longer here has no such claim to make.
 */
describe("useSendMessage: the reconciliation loop", () => {
  test("a stale send leaves the open thread's timer running", async () => {
    useConversationStore.getState().setActiveConversationId(OPEN_CONVERSATION);
    const { result, cancelReconciliation } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("what am I holding?");
    });

    expect(cancelReconciliation).not.toHaveBeenCalled();
  });

  test("an on-screen send still cancels it", async () => {
    useConversationStore.getState().setActiveConversationId(SEND_CONVERSATION);
    const { result, cancelReconciliation } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("still here");
    });

    expect(cancelReconciliation).toHaveBeenCalledTimes(1);
  });
});

/**
 * `/doctor` leaves the conversation entirely: it parks a hand-off prompt and
 * navigates the window to the Doctor panel. Delivered late, that is a command
 * from a thread the user left taking over the one they are working in, so it is
 * dropped rather than deferred.
 */
describe("useSendMessage: a late /doctor", () => {
  test("neither navigates nor parks once its thread is behind the user", async () => {
    useConversationStore.getState().setActiveConversationId(OPEN_CONVERSATION);
    // What the user has since typed in the thread they moved to.
    useComposerStore.setState({ input: "half a thought" });
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("/doctor fix my profiles");
    });

    expect(currentLocation).toBe(START_LOCATION);
    // Nothing half-ran: a parked prompt with no navigation would surface on
    // the user's next manual visit to the Doctor, and the clear both branches
    // do would wipe a composer that is no longer this send's.
    expect(useDoctorHandoffStore.getState().pendingPrompt).toBeNull();
    expect(useComposerStore.getState().input).toBe("half a thought");
  });

  test("a bare /doctor is dropped whole too", async () => {
    // The prompt is empty, so only the navigation is on offer, and it is the
    // half that does the hijacking.
    useConversationStore.getState().setActiveConversationId(OPEN_CONVERSATION);
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("/doctor");
    });

    expect(currentLocation).toBe(START_LOCATION);
  });

  test("on its own thread it behaves as it always has", async () => {
    useConversationStore.getState().setActiveConversationId(SEND_CONVERSATION);
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("/doctor fix my profiles");
    });

    expect(currentLocation).not.toBe(START_LOCATION);
    expect(currentLocation).toContain("tab=doctor");
    expect(useDoctorHandoffStore.getState().pendingPrompt).toBe(
      "fix my profiles",
    );
  });

  test("the send never reaches the daemon either way", async () => {
    // `/doctor` is resolved entirely on the client: no POST, on screen or off.
    useConversationStore.getState().setActiveConversationId(SEND_CONVERSATION);
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("/doctor fix my profiles");
    });

    expect(capturedBody).toBeNull();
  });
});
