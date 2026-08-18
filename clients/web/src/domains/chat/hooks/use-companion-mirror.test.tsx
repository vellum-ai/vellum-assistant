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
});

/** The most recent push, which is what the surface would be drawing. */
const latest = (): CompanionContext => {
  const last = published.at(-1);
  if (!last) {
    throw new Error("Expected the mirror to have published a context");
  }
  return last;
};

describe("the working flag the companion mirror publishes", () => {
  test("is false with no turn running", () => {
    render(<Mirror />);
    expect(latest().working).toBe(false);
  });

  test("goes true when a turn starts", async () => {
    render(<Mirror />);
    useTurnStore.getState().requestSend("turn-1");
    await waitFor(() => {
      expect(latest().working).toBe(true);
    });
  });

  test("goes false again when the turn completes", async () => {
    render(<Mirror />);
    useTurnStore.getState().requestSend("turn-1");
    await waitFor(() => {
      expect(latest().working).toBe(true);
    });
    useTurnStore.getState().completeTurn();
    await waitFor(() => {
      expect(latest().working).toBe(false);
    });
  });

  /**
   * A turn that has stopped to ask something is not the assistant working, and
   * a surface still saying it is would be telling the user to wait for a reply
   * that is waiting on them.
   */
  test("is false while the turn is waiting on the user", async () => {
    render(<Mirror />);
    useTurnStore.getState().requestSend("turn-1");
    await waitFor(() => {
      expect(latest().working).toBe(true);
    });
    useTurnStore.getState().onQuestionRequest();
    await waitFor(() => {
      expect(latest().working).toBe(false);
    });
  });

  /**
   * The phase moves on its own schedule: a reply being thought about has no
   * text yet and a finished one leaves its last text where it was, so neither
   * edge of a turn necessarily moves a row the card draws.
   */
  test("is published even when no drawn row changed", async () => {
    render(<Mirror />);
    const before = published.length;
    useTurnStore.getState().requestSend("turn-1");
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
  test("says nothing from a window that never published", async () => {
    isPopout = true;
    const view = render(<Mirror />);

    view.unmount();

    expect(clearWorkingMock).not.toHaveBeenCalled();
  });
});

/**
 * The turn phase is reset outright by a conversation switch, and the surface's
 * own composer causes one: it sends into a draft conversation whose id the
 * server replaces on `ready`. That lands at almost exactly the moment the first
 * reply events arrive, so a ring driven by the phase alone lit for the wait and
 * went out the instant the answer started.
 */
describe("a turn that outlives its conversation id", () => {
  const startProcessing = (id: string) => {
    useConversationStore.setState({
      processingConversationIds: new Set([id]),
    });
  };

  test("keeps working through the switch that resets the phase", async () => {
    render(<Mirror />);
    useTurnStore.getState().requestSend("turn-1");
    startProcessing("draft-1");
    await waitFor(() => {
      expect(latest().working).toBe(true);
    });

    // The switch: the draft id is replaced and the local reducer is wiped.
    useTurnStore.getState().resetTurn();
    await Promise.resolve();

    expect(latest().working).toBe(true);
  });

  test("gives up only once the conversation stops processing", async () => {
    render(<Mirror />);
    useTurnStore.getState().requestSend("turn-1");
    startProcessing("draft-1");
    await waitFor(() => {
      expect(latest().working).toBe(true);
    });
    useTurnStore.getState().resetTurn();

    useConversationStore.setState({ processingConversationIds: new Set() });

    await waitFor(() => {
      expect(latest().working).toBe(false);
    });
  });

  /**
   * The surface is the assistant's presence on the desktop rather than a view
   * of one thread, so a turn the user is not looking at still counts.
   */
  test("works for a conversation the app is not showing", async () => {
    render(<Mirror />);

    startProcessing("some-other-conversation");

    await waitFor(() => {
      expect(latest().working).toBe(true);
    });
  });
});
