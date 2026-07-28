/**
 * Tests for archiveResearchConversation's best-effort contract: it must call
 * the archive endpoint with the right path + `throwOnError: false`, and swallow
 * every failure mode (a thrown SDK call, a non-ok response) so the
 * research-onboarding handoff is never blocked.
 *
 * NOTE: `bun mock.module` can leak across files — run this file singly:
 *   bun test src/domains/onboarding/archive-research-conversation.test.ts
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import * as sdkGen from "@/generated/daemon/sdk.gen";

interface ArchiveCall {
  path: { assistant_id: string; id: string };
  throwOnError: false;
}

let calls: ArchiveCall[] = [];
let responseOk = true;
let responseStatus = 200;
let shouldThrow = false;

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkGen,
  conversationsByIdArchivePost: (opts: ArchiveCall) => {
    calls.push(opts);
    if (shouldThrow) {
      return Promise.reject(new Error("network blew up"));
    }
    return Promise.resolve({
      data: {},
      error: undefined,
      response: { ok: responseOk, status: responseStatus },
    });
  },
}));

const { archiveResearchConversation } = await import(
  "./archive-research-conversation"
);

afterEach(() => {
  calls = [];
  responseOk = true;
  responseStatus = 200;
  shouldThrow = false;
});

describe("archiveResearchConversation", () => {
  test("archives with the assistant + conversation path and throwOnError: false", async () => {
    await archiveResearchConversation("a1", "c1");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toEqual({ assistant_id: "a1", id: "c1" });
    expect(calls[0]?.throwOnError).toBe(false);
  });

  test("swallows a thrown SDK call without rejecting", async () => {
    shouldThrow = true;

    await expect(
      archiveResearchConversation("a1", "c1"),
    ).resolves.toBeUndefined();
  });

  test("does not throw on a non-ok response", async () => {
    responseOk = false;
    responseStatus = 500;

    await expect(
      archiveResearchConversation("a1", "c1"),
    ).resolves.toBeUndefined();
  });
});
