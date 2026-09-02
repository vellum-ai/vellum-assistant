/**
 * Terminal (and other) parent injections rebuild a stale idle parent before
 * the notification turn, so a reload or credential rotation is visible to
 * that turn. A parent that still has in-flight work keeps its current
 * instance so children are not aborted.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const parentState = { stale: false, inFlight: false };
const rebuilt: string[] = [];
const delivered: string[] = [];

mock.module("../daemon/conversation-registry.js", () => ({
  findConversation: (id: string) => {
    if (id === "missing-parent") {
      return undefined;
    }
    return {
      isStale: () => parentState.stale,
      hasInFlightWork: () => parentState.inFlight,
      enqueueMessage: (options: { content: string }) => {
        delivered.push(options.content);
        return { queued: true };
      },
      persistUserMessage: async () => ({ id: "mock-msg" }),
      runAgentLoop: async () => {},
    };
  },
}));

mock.module("../daemon/conversation-store.js", () => ({
  getOrCreateConversation: async (id: string) => {
    rebuilt.push(id);
    return {
      enqueueMessage: (options: { content: string }) => {
        delivered.push(`rebuilt:${options.content}`);
        return { queued: true };
      },
      persistUserMessage: async () => ({ id: "rebuilt-msg" }),
      runAgentLoop: async () => {},
    };
  },
}));

import { injectMessageIntoParent } from "../subagent/notify.js";

describe("injectMessageIntoParent stale rebuild", () => {
  beforeEach(() => {
    parentState.stale = false;
    parentState.inFlight = false;
    rebuilt.length = 0;
    delivered.length = 0;
  });

  test("delivers on the live instance when the parent is not stale", () => {
    injectMessageIntoParent("parent-1", "child done");

    expect(rebuilt).toEqual([]);
    expect(delivered).toEqual(["child done"]);
  });

  test("keeps the live instance while the parent still has in-flight work", () => {
    parentState.stale = true;
    parentState.inFlight = true;

    injectMessageIntoParent("parent-1", "child still running");

    expect(rebuilt).toEqual([]);
    expect(delivered).toEqual(["child still running"]);
  });

  test("rebuilds a stale idle parent before the notification turn", async () => {
    parentState.stale = true;
    parentState.inFlight = false;

    injectMessageIntoParent("parent-1", "child done");
    const start = Date.now();
    while (delivered.length === 0 && Date.now() - start < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(rebuilt).toEqual(["parent-1"]);
    expect(delivered).toEqual(["rebuilt:child done"]);
  });
});
