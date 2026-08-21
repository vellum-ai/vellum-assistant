import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { WatchRetroCompletedEvent } from "@vellumai/assistant-api";

import {
  beginWatchRetro,
  clearWatchRetro,
  settleWatchRetro,
  useWatchRetroStore,
} from "@/domains/chat/watch/watch-retro";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const ASSISTANT_ID = "asst-owner";

const SESSION = {
  sessionId: "sess-1",
  conversationId: "conv-1",
  assistantId: ASSISTANT_ID,
};

/** Make `assistantId` the active one, which is what the state is bound to. */
const activate = (assistantId: string | null) => {
  useResolvedAssistantsStore.getState().setActiveAssistantId(assistantId);
};

/** The runtime's announcement, in the shape the event stream carries it. */
const completed = (
  fields: Partial<WatchRetroCompletedEvent> = {},
): WatchRetroCompletedEvent => ({
  type: "watch_retro_completed",
  sessionId: SESSION.sessionId,
  conversationId: SESSION.conversationId,
  reportReady: true,
  ...fields,
});

const retro = () => useWatchRetroStore.getState().retro;

beforeEach(() => {
  clearWatchRetro();
  activate(ASSISTANT_ID);
});

afterEach(() => {
  // The give-up timer outlives the test that armed it, and an unhandled one
  // firing later writes the store out from under whatever runs next. So does
  // the owner subscription, which `clearWatchRetro` releases.
  clearWatchRetro();
  activate(null);
});

describe("watch session summary", () => {
  test("a stopped session is pending until the runtime answers", () => {
    beginWatchRetro(SESSION);

    expect(retro()).toEqual({
      sessionId: "sess-1",
      conversationId: "conv-1",
      assistantId: ASSISTANT_ID,
      phase: "pending",
    });
  });

  test("a report to read becomes a question", () => {
    beginWatchRetro(SESSION);

    settleWatchRetro(completed());

    expect(retro()?.phase).toBe("ready");
  });

  // The conversation the report landed in is the runtime's answer, not the one
  // the session opened with: a session can adopt a conversation it did not mint.
  test("the conversation to open is the one the runtime named", () => {
    beginWatchRetro(SESSION);

    settleWatchRetro(completed({ conversationId: "conv-report" }));

    expect(retro()?.conversationId).toBe("conv-report");
  });

  // Offering to open a thread the runtime deliberately left hidden would be
  // offering an empty conversation.
  test("nothing to read clears the wait instead of asking", () => {
    beginWatchRetro(SESSION);

    settleWatchRetro(completed({ reportReady: false }));

    expect(retro()).toBeNull();
  });

  // A late announcement for a session the user has already moved past must not
  // resurrect its prompt or overwrite the one they are being asked now.
  test("an announcement for another session is ignored", () => {
    beginWatchRetro(SESSION);

    settleWatchRetro(completed({ sessionId: "sess-other" }));

    expect(retro()?.phase).toBe("pending");
  });

  test("an announcement with nothing waiting on it is dropped", () => {
    settleWatchRetro(completed());

    expect(retro()).toBeNull();
  });

  test("a second session replaces the summary the first was waiting on", () => {
    beginWatchRetro(SESSION);

    beginWatchRetro({
      sessionId: "sess-2",
      conversationId: "conv-2",
      assistantId: ASSISTANT_ID,
    });

    expect(retro()?.sessionId).toBe("sess-2");
    // And the first session's answer no longer moves anything.
    settleWatchRetro(completed());
    expect(retro()?.phase).toBe("pending");
  });

  test("answering puts the surface back to having nothing to say", () => {
    beginWatchRetro(SESSION);
    settleWatchRetro(completed());

    clearWatchRetro();

    expect(retro()).toBeNull();
  });
});

/**
 * A watch session belongs to one assistant, and so does the account of it. The
 * SSE service detaches from the old assistant on a switch, so a wait carried
 * across one can never be settled, and a question carried across one is asked
 * under the wrong name about a conversation the new assistant does not have.
 */
describe("the assistant the summary belongs to", () => {
  test("switching assistants drops a summary still being written", () => {
    beginWatchRetro(SESSION);

    activate("asst-other");

    expect(retro()).toBeNull();
  });

  test("switching assistants drops a question already waiting on an answer", () => {
    beginWatchRetro(SESSION);
    settleWatchRetro(completed());
    expect(retro()?.phase).toBe("ready");

    activate("asst-other");

    expect(retro()).toBeNull();
  });

  // Ambiguous rather than benign, and the safe reading is the controller's:
  // stop claiming anything.
  test("switching to no assistant at all drops it too", () => {
    beginWatchRetro(SESSION);

    activate(null);

    expect(retro()).toBeNull();
  });

  test("a summary dropped that way stays dropped when its answer arrives", () => {
    beginWatchRetro(SESSION);
    activate("asst-other");

    settleWatchRetro(completed());

    expect(retro()).toBeNull();
  });

  /**
   * The owner is the session's, not the store's current reading of it: the
   * report lands in a conversation only that assistant has.
   */
  test("the report keeps its owner when the runtime names its conversation", () => {
    beginWatchRetro(SESSION);

    settleWatchRetro(completed({ conversationId: "conv-report" }));

    expect(retro()?.assistantId).toBe(ASSISTANT_ID);
  });

  // A released subscription must not go on watching: the next switch would
  // otherwise clear a summary belonging to a session started since.
  test("a cleared summary stops listening for switches", () => {
    beginWatchRetro(SESSION);
    clearWatchRetro();

    activate("asst-other");
    beginWatchRetro({
      sessionId: "sess-2",
      conversationId: "conv-2",
      assistantId: "asst-other",
    });
    activate("asst-other");

    expect(retro()?.sessionId).toBe("sess-2");
  });
});
