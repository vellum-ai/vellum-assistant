/**
 * Tests for the research-correction helper.
 *
 * `buildResearchCorrection` is pure and covers the message wording / no-op
 * cases. `sendResearchCorrection` must post the correction to the research
 * conversation, then re-archive it, and swallow every failure so the
 * onboarding handoff is never blocked.
 *
 * NOTE: `bun mock.module` can leak across files — run this file singly:
 *   bun test src/domains/onboarding/send-research-correction.test.ts
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import * as sdkGen from "@/generated/daemon/sdk.gen";

interface PostCall {
  path: { assistant_id: string };
  body: {
    conversationId: string;
    content: string;
    interface?: string;
    clientOs?: string;
  };
  throwOnError: false;
}
interface ArchiveCall {
  path: { assistant_id: string; id: string };
  throwOnError: false;
}

let postCalls: PostCall[] = [];
let archiveCalls: ArchiveCall[] = [];
let postShouldThrow = false;

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkGen,
  messagesPost: (opts: PostCall) => {
    postCalls.push(opts);
    if (postShouldThrow) return Promise.reject(new Error("network blew up"));
    return Promise.resolve({
      data: {},
      error: undefined,
      response: { ok: true, status: 200 },
    });
  },
  conversationsByIdArchivePost: (opts: ArchiveCall) => {
    archiveCalls.push(opts);
    return Promise.resolve({
      data: {},
      error: undefined,
      response: { ok: true, status: 200 },
    });
  },
}));

const { buildResearchCorrection, sendResearchCorrection } =
  await import("./send-research-correction");

afterEach(() => {
  postCalls = [];
  archiveCalls = [];
  postShouldThrow = false;
});

describe("buildResearchCorrection", () => {
  test("lists the removed claims when some were pruned", () => {
    const msg = buildResearchCorrection({
      removedClaims: ["Based in Oakland, CA", "Founded Weird Canada"],
      rejectedAll: false,
    });
    expect(msg).toContain("- Based in Oakland, CA");
    expect(msg).toContain("- Founded Weird Canada");
    expect(msg).toContain("disregard");
  });

  test("returns null when nothing was removed (no correction to send)", () => {
    expect(
      buildResearchCorrection({ removedClaims: [], rejectedAll: false }),
    ).toBeNull();
    // Blank/whitespace-only entries don't count as removals.
    expect(
      buildResearchCorrection({ removedClaims: ["  "], rejectedAll: false }),
    ).toBeNull();
  });

  test("disowns the whole search on full rejection, ignoring the list", () => {
    const msg = buildResearchCorrection({
      removedClaims: [],
      rejectedAll: true,
    });
    expect(msg).toContain("none of what you found");
    expect(msg).toContain("similar name");
  });
});

describe("sendResearchCorrection", () => {
  test("posts the correction then re-archives the conversation", async () => {
    await sendResearchCorrection({
      assistantId: "a1",
      conversationId: "c1",
      removedClaims: ["Based in Oakland, CA"],
      rejectedAll: false,
    });

    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.path).toEqual({ assistant_id: "a1" });
    expect(postCalls[0]?.body.conversationId).toBe("c1");
    expect(postCalls[0]?.throwOnError).toBe(false);
    // The correction turn carries the transport interface + real OS so the
    // assistant keeps platform context (mirrors the initial research send).
    expect(postCalls[0]?.body.interface).toBe("web");
    expect(postCalls[0]?.body.clientOs).toBe("web");

    expect(archiveCalls).toHaveLength(1);
    expect(archiveCalls[0]?.path).toEqual({ assistant_id: "a1", id: "c1" });
  });

  test("no-ops (no post, no archive) when there's nothing to correct", async () => {
    await sendResearchCorrection({
      assistantId: "a1",
      conversationId: "c1",
      removedClaims: [],
      rejectedAll: false,
    });

    expect(postCalls).toHaveLength(0);
    expect(archiveCalls).toHaveLength(0);
  });

  test("swallows a thrown post and still re-archives", async () => {
    postShouldThrow = true;

    await expect(
      sendResearchCorrection({
        assistantId: "a1",
        conversationId: "c1",
        removedClaims: ["x"],
        rejectedAll: false,
      }),
    ).resolves.toBeUndefined();

    expect(archiveCalls).toHaveLength(1);
  });
});
