import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { CompanionContext } from "@vellumai/ipc-contract";
import type * as WatchController from "@/domains/chat/watch/watch-controller";

const published: CompanionContext[] = [];
// Counted rather than reimplemented: what this hook owns is calling the clear
// at teardown. What the clear then publishes is the runtime module's own rule,
// and `runtime/companion-surface.test.ts` exercises the real one.
const clearWorkingMock = mock(() => undefined);

mock.module("@/runtime/companion-surface", () => ({
  setCompanionContext: (context: CompanionContext) => {
    published.push(context);
  },
  clearCompanionWorking: clearWorkingMock,
}));

let isPopout = false;
mock.module("@/runtime/popout-window", () => ({
  isPopoutWindowLifetime: () => isPopout,
}));

// The session itself is the watch controller's, and its own test drives the
// real socket and the real capture. What this hook owns is publishing the flag
// and ending the session at teardown, so the module is stood in for by the
// flag and a counted stop.
let watching = false;
let captureCount = 0;
const watchListeners = new Set<() => void>();
const stopWatchMock = mock(() => {
  setWatching(false);
});
mock.module(
  "@/domains/chat/watch/watch-controller",
  (): Partial<typeof WatchController> => ({
    stopWatch: stopWatchMock,
    useWatchStore: {
      getState: () => ({ watching, captureCount }),
      subscribe: (listener: () => void) => {
        watchListeners.add(listener);
        return () => {
          watchListeners.delete(listener);
        };
      },
    } as unknown as typeof WatchController.useWatchStore,
  }),
);

/** Wake the hook the way any write to the controller's store does. */
const notifyWatchListeners = () => {
  for (const listener of [...watchListeners]) {
    listener();
  }
};

/** Flip the session the way the controller does, listeners and all. */
const setWatching = (next: boolean) => {
  watching = next;
  captureCount = 0;
  notifyWatchListeners();
};

/** One screen read landing, which is the other thing the session publishes. */
const captureLanded = () => {
  captureCount += 1;
  notifyWatchListeners();
};

const { useTurnStore } = await import("@/domains/chat/turn-store");
const { useConversationStore } = await import("@/stores/conversation-store");
const { useChatSessionStore } = await import(
  "@/domains/chat/chat-session-store"
);
// The summary store is the real one: it holds nothing but a value and a timer,
// and what this hook owns is publishing the phase it reports.
const { beginWatchRetro, clearWatchRetro, settleWatchRetro } = await import(
  "@/domains/chat/watch/watch-retro"
);
const { useCompanionMirror } = await import("./use-companion-mirror");

function Mirror() {
  useCompanionMirror();
  return null;
}

afterEach(() => {
  cleanup();
  published.length = 0;
  clearWorkingMock.mockClear();
  stopWatchMock.mockClear();
  watching = false;
  captureCount = 0;
  watchListeners.clear();
  clearWatchRetro();
  isPopout = false;
  useTurnStore.getState().resetTurn();
  useConversationStore.setState({ processingConversationIds: new Set() });
  useChatSessionStore.setState({ snapshot: null } as never);
});

/** The most recent push, which is what the surface would be drawing. */
const latest = (): CompanionContext => {
  const last = published.at(-1);
  if (!last) {
    throw new Error("Expected the mirror to have published a context");
  }
  return last;
};

const processing = (...ids: string[]) => {
  useConversationStore.setState({ processingConversationIds: new Set(ids) });
};

/** The daemon's own flag, as it rides the rolling snapshot. */
const daemonProcessing = (value: boolean | undefined) => {
  const { snapshot } = useChatSessionStore.getState();
  useChatSessionStore.setState({
    snapshot: { ...(snapshot ?? { messages: [] }), processing: value },
  } as never);
};

describe("the working flag the companion mirror publishes", () => {
  test("is false with no turn running", () => {
    render(<Mirror />);
    expect(latest().working).toBe(false);
  });

  test("goes true when a turn starts", async () => {
    render(<Mirror />);
    processing("conv-1");
    await waitFor(() => {
      expect(latest().working).toBe(true);
    });
  });

  test("goes false again when the turn finishes", async () => {
    render(<Mirror />);
    processing("conv-1");
    await waitFor(() => {
      expect(latest().working).toBe(true);
    });
    processing();
    await waitFor(() => {
      expect(latest().working).toBe(false);
    });
  });

  /**
   * The whole turn, not the shape of it. Thinking, a tool running, and waiting
   * on an answer are all one turn as far as the surface is concerned, and a
   * ring that dropped out between them would report the stages rather than that
   * there is a turn at all.
   */
  test("holds through a turn that stops to ask the user something", async () => {
    render(<Mirror />);
    processing("conv-1");
    await waitFor(() => {
      expect(latest().working).toBe(true);
    });

    useTurnStore.getState().onQuestionRequest();
    await Promise.resolve();

    expect(latest().working).toBe(true);
  });

  /**
   * The phase is reset outright by a conversation switch, and the surface's own
   * composer causes one: it sends into a draft conversation whose id the server
   * replaces on `ready`, which lands about when the first reply events arrive.
   * A phase-derived ring lit for the wait and went out as the answer started.
   */
  test("survives the conversation switch that resets the turn phase", async () => {
    render(<Mirror />);
    processing("draft-1");
    await waitFor(() => {
      expect(latest().working).toBe(true);
    });

    useTurnStore.getState().resetTurn();
    await Promise.resolve();

    expect(latest().working).toBe(true);
  });

  /**
   * The surface is the assistant's presence on the desktop rather than a view
   * of one thread, so a turn the user is not looking at still counts.
   */
  test("works for a conversation the app is not showing", async () => {
    render(<Mirror />);
    processing("some-other-conversation");
    await waitFor(() => {
      expect(latest().working).toBe(true);
    });
  });

  test("is published even when no drawn row changed", async () => {
    render(<Mirror />);
    const before = published.length;
    processing("conv-1");
    await waitFor(() => {
      expect(published.length).toBeGreaterThan(before);
    });
    expect(latest().turns).toEqual([]);
  });
});

/**
 * The publisher going away is not the assistant stopping work, but nothing else
 * is left to say the turn ended: main holds the last context it was given, and
 * the surface is opened by a feature flag and the tray preference rather than
 * by the window that was publishing. So the last thing this hook does is give
 * up the claim.
 */
describe("giving up the claim that a turn is running", () => {
  test("gives it up when the mirror unmounts", () => {
    const view = render(<Mirror />);

    view.unmount();

    expect(clearWorkingMock).toHaveBeenCalledTimes(1);
  });

  /**
   * A pop-out never publishes, so it has nothing to give up, and doing so would
   * clear the flag the main window is legitimately holding.
   */
  test("says nothing from a window that never published", () => {
    isPopout = true;
    const view = render(<Mirror />);

    view.unmount();

    expect(clearWorkingMock).not.toHaveBeenCalled();
  });
});

/**
 * The long middle of a turn: the assistant is working, the local reducer has
 * been wiped by the draft-to-real conversation switch, that switch has taken
 * the draft's id out of the optimistic mirror, and nothing is streaming yet.
 *
 * Every client-side signal reads idle here. Only the daemon's own flag knows a
 * turn is running, which is why the ring went dark in exactly this window and
 * came back the moment the first delta arrived.
 */
describe("the middle of a turn, where the client looks idle", () => {
  test("stays lit on the daemon's flag alone", async () => {
    render(<Mirror />);
    processing("draft-1");
    await waitFor(() => {
      expect(latest().working).toBe(true);
    });

    // The daemon reports the turn, then every local trace of it goes away.
    daemonProcessing(true);
    useTurnStore.getState().resetTurn();
    processing();
    await waitFor(() => {
      expect(latest().working).toBe(true);
    });

    expect(latest().working).toBe(true);
  });

  test("goes out when the daemon says the turn is over", async () => {
    render(<Mirror />);
    daemonProcessing(true);
    await waitFor(() => {
      expect(latest().working).toBe(true);
    });

    daemonProcessing(false);

    await waitFor(() => {
      expect(latest().working).toBe(false);
    });
  });
});

/**
 * The summary of a finished session crosses the same bridge as the flag, and
 * has one more reason to: the runtime announces the retrospective on this
 * window's event stream, and the surface's own renderer is not subscribed to
 * it. Without this the surface would go quiet for the whole of a turn the user
 * is waiting on.
 */
describe("the watch summary the companion mirror publishes", () => {
  const SESSION = {
    sessionId: "sess-1",
    conversationId: "conv-1",
    assistantId: "asst-owner",
  };

  test("says nothing when no session has finished", () => {
    render(<Mirror />);
    expect(latest().watchRetro).toBeUndefined();
  });

  test("is pending from the stop press", async () => {
    render(<Mirror />);
    beginWatchRetro(SESSION);
    await waitFor(() => {
      expect(latest().watchRetro).toBe("pending");
    });
  });

  test("becomes the question once the runtime answers", async () => {
    render(<Mirror />);
    beginWatchRetro(SESSION);
    await waitFor(() => {
      expect(latest().watchRetro).toBe("pending");
    });

    settleWatchRetro({
      type: "watch_retro_completed",
      sessionId: SESSION.sessionId,
      conversationId: SESSION.conversationId,
      reportReady: true,
    });

    await waitFor(() => {
      expect(latest().watchRetro).toBe("ready");
    });
  });

  test("goes back to silence once the question is answered", async () => {
    render(<Mirror />);
    beginWatchRetro(SESSION);
    await waitFor(() => {
      expect(latest().watchRetro).toBe("pending");
    });

    clearWatchRetro();

    await waitFor(() => {
      expect(latest().watchRetro).toBeUndefined();
    });
  });
});

/**
 * The watch session runs in this window and is drawn on another, so the flag
 * has to cross the same bridge the tail does. It moves on its own schedule:
 * the session is started by a command from the surface and can end on its own
 * when the socket drops, neither of which writes any store the tail reads.
 */
describe("the watch flag the companion mirror publishes", () => {
  test("is false with no session running", () => {
    render(<Mirror />);
    expect(latest().watching).toBe(false);
  });

  test("goes true when a session starts", async () => {
    render(<Mirror />);
    setWatching(true);
    await waitFor(() => {
      expect(latest().watching).toBe(true);
    });
  });

  test("goes false again when the session ends", async () => {
    render(<Mirror />);
    setWatching(true);
    await waitFor(() => {
      expect(latest().watching).toBe(true);
    });

    setWatching(false);

    await waitFor(() => {
      expect(latest().watching).toBe(false);
    });
  });

  /**
   * Every push is an IPC message and a repaint of a window floating over
   * another app's work, and the stores under this hook are written far more
   * often than the card changes.
   */
  test("says nothing when the session has not moved", async () => {
    render(<Mirror />);
    setWatching(true);
    await waitFor(() => {
      expect(latest().watching).toBe(true);
    });
    const count = published.length;

    setWatching(true);
    setWatching(true);

    expect(published.length).toBe(count);
  });
});

/**
 * The session's screen reads cross the same bridge the flag does, and they are
 * the half the surface draws a capture from: the flag says a session is open,
 * and only this says the screen has been read.
 */
describe("the capture count the companion mirror publishes", () => {
  test("is none for a session that has captured nothing", async () => {
    render(<Mirror />);
    setWatching(true);
    await waitFor(() => {
      expect(latest().watching).toBe(true);
    });

    expect(latest().captureCount).toBe(0);
  });

  test("publishes each capture the session reports", async () => {
    render(<Mirror />);
    setWatching(true);
    await waitFor(() => {
      expect(latest().watching).toBe(true);
    });

    captureLanded();
    await waitFor(() => {
      expect(latest().captureCount).toBe(1);
    });

    captureLanded();
    await waitFor(() => {
      expect(latest().captureCount).toBe(2);
    });
  });

  /**
   * A capture that moved nothing else about the card still has to go out. It
   * is the one fact on this bridge with no other carrier: the tail, the name,
   * and the working flag are all unchanged by a screen being read.
   */
  test("pushes for a capture that changed nothing else", async () => {
    render(<Mirror />);
    setWatching(true);
    await waitFor(() => {
      expect(latest().watching).toBe(true);
    });
    const count = published.length;

    captureLanded();

    await waitFor(() => {
      expect(published.length).toBe(count + 1);
    });
  });
});

/**
 * The microphone and the socket are in this window. A layout going away takes
 * the only thing that could stop them with it, so the session goes with the
 * layout rather than being left running with nothing able to reach it.
 */
describe("the watch session at teardown", () => {
  test("ends the session on unmount", () => {
    const view = render(<Mirror />);
    setWatching(true);

    view.unmount();

    expect(stopWatchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * Ended before the subscriptions go, so the flip is still published. A stop
   * the surface never hears about leaves a capture indicator standing over a
   * machine nothing is reading.
   */
  test("publishes the session ending before it stops listening", () => {
    const view = render(<Mirror />);
    setWatching(true);

    view.unmount();

    expect(latest().watching).toBe(false);
  });

  test("says nothing when no session was running", () => {
    const view = render(<Mirror />);
    const count = published.length;

    view.unmount();

    expect(published.length).toBe(count);
  });
});
