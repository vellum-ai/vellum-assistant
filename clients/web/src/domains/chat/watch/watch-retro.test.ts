import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { WatchRetroCompletedEvent } from "@vellumai/assistant-api";

import {
  beginWatchRetro,
  clearWatchRetro,
  settleWatchRetro,
  useWatchRetroStore,
} from "@/domains/chat/watch/watch-retro";

const SESSION = { sessionId: "sess-1", conversationId: "conv-1" };

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
});

afterEach(() => {
  // The give-up timer outlives the test that armed it, and an unhandled one
  // firing later writes the store out from under whatever runs next.
  clearWatchRetro();
});

describe("watch session summary", () => {
  test("a stopped session is pending until the runtime answers", () => {
    beginWatchRetro(SESSION);

    expect(retro()).toEqual({
      sessionId: "sess-1",
      conversationId: "conv-1",
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

    beginWatchRetro({ sessionId: "sess-2", conversationId: "conv-2" });

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
