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

function deliveryTarget(prefix: string) {
  return {
    isProcessing: () => false,
    waitForIdle: async () => true,
    persistUserMessage: async (options: { content: string }) => {
      delivered.push(`${prefix}${options.content}`);
      return { id: `msg-${delivered.length}` };
    },
    runAgentLoop: async () => {},
  };
}

mock.module("../daemon/conversation-registry.js", () => ({
  findConversation: (id: string) => {
    if (id === "missing-parent") {
      return undefined;
    }
    return {
      isStale: () => parentState.stale,
      hasInFlightWork: () => parentState.inFlight,
      ...deliveryTarget(""),
    };
  },
}));

mock.module("../daemon/conversation-store.js", () => ({
  getOrCreateConversation: async (id: string) => {
    rebuilt.push(id);
    return deliveryTarget("rebuilt:");
  },
}));

import { __resetConversationAdmissionForTests } from "../daemon/conversation-admission.js";
import { injectMessageIntoParent } from "../subagent/notify.js";

/** Let a registered delivery reach its persist. */
const settleDeliveries = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("injectMessageIntoParent stale rebuild", () => {
  beforeEach(() => {
    __resetConversationAdmissionForTests();
    parentState.stale = false;
    parentState.inFlight = false;
    rebuilt.length = 0;
    delivered.length = 0;
  });

  test("delivers on the live instance when the parent is not stale", async () => {
    injectMessageIntoParent("parent-1", "child done");
    await settleDeliveries();

    expect(rebuilt).toEqual([]);
    expect(delivered).toEqual(["child done"]);
  });

  test("keeps the live instance while the parent still has in-flight work", async () => {
    parentState.stale = true;
    parentState.inFlight = true;

    injectMessageIntoParent("parent-1", "child still running");
    await settleDeliveries();

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
