import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { CompanionContext } from "@vellumai/ipc-contract";

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

const { useTurnStore } = await import("@/domains/chat/turn-store");
const { useConversationStore } = await import("@/stores/conversation-store");
const { useChatSessionStore } = await import(
  "@/domains/chat/chat-session-store"
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
