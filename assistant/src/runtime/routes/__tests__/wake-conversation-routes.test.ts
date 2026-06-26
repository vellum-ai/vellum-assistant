/**
 * Asserts the `wake_conversation` route elevates trust from the caller's
 * verified principal type, never the request body: a `local` (CLI/IPC) caller
 * runs the woken turn as a non-interactive guardian (clientless + guardian
 * trustContext) and may attribute cost to a body-supplied `cronRunId`; a remote
 * `actor` stays `unknown`/interactive and its body `cronRunId` is ignored.
 */

import { describe, expect, mock, test } from "bun:test";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

interface CapturedWake {
  conversationId: string;
  hint: string;
  trustContext?: { sourceChannel: string; trustClass: string };
  cronRunId?: string;
  clientless?: boolean;
}
const wakeCalls: CapturedWake[] = [];
mock.module("../../agent-wake.js", () => ({
  wakeAgentForOpportunity: (opts: CapturedWake) => {
    wakeCalls.push(opts);
    return { invoked: true, producedToolCalls: false };
  },
}));

import { createConversation } from "../../../persistence/conversation-crud.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { ROUTES } from "../wake-conversation-routes.js";

await initializeDb();

const handler = (() => {
  const route = ROUTES.find((r) => r.operationId === "wake_conversation");
  if (!route) throw new Error("wake_conversation route not found");
  return route.handler;
})();

function makeConversation(): string {
  return createConversation({ conversationType: "scheduled" }).id;
}

describe("wake_conversation principal-gated elevation", () => {
  test("local principal → non-interactive guardian, honors body cronRunId", async () => {
    wakeCalls.length = 0;
    const conversationId = makeConversation();
    const result = await handler({
      body: { conversationId, hint: "poll result", cronRunId: "run-1" },
      principalType: "local",
    });
    expect(result).toEqual({ invoked: true, producedToolCalls: false });
    expect(wakeCalls).toHaveLength(1);
    expect(wakeCalls[0].trustContext).toEqual({
      sourceChannel: "vellum",
      trustClass: "guardian",
    });
    expect(wakeCalls[0].clientless).toBe(true);
    expect(wakeCalls[0].cronRunId).toBe("run-1");
  });

  test("actor principal → interactive, no elevation, ignores body cronRunId", async () => {
    wakeCalls.length = 0;
    const conversationId = makeConversation();
    await handler({
      body: { conversationId, hint: "poll result", cronRunId: "attacker-run" },
      principalType: "actor",
    });
    expect(wakeCalls[0].trustContext).toBeUndefined();
    expect(wakeCalls[0].clientless).toBeUndefined();
    expect(wakeCalls[0].cronRunId).toBeUndefined();
  });

  test("missing principal type defaults to no elevation (fail-safe)", async () => {
    wakeCalls.length = 0;
    const conversationId = makeConversation();
    await handler({
      body: { conversationId, hint: "poll", cronRunId: "ignored-run" },
    });
    expect(wakeCalls[0].trustContext).toBeUndefined();
    expect(wakeCalls[0].clientless).toBeUndefined();
    expect(wakeCalls[0].cronRunId).toBeUndefined();
  });
});
