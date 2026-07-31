/**
 * Pins the shape of the identity-rewrite send: it goes out hidden (see
 * `lib/side-conversation-message.ts`) and the side conversation is archived.
 *
 * NOTE: `bun mock.module` can leak across files. Run this file singly:
 *   bun test src/domains/intelligence/identity-actions/run-identity-rewrite.test.ts
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import * as sdkGen from "@/generated/daemon/sdk.gen";

interface PostCall {
  path: { assistant_id: string };
  body: { conversationId: string; content: string; hidden?: boolean };
}

let postCalls: PostCall[] = [];
let archiveCalls: Array<{ path: { assistant_id: string; id: string } }> = [];

const ok = <T>(data: T) =>
  Promise.resolve({ data, error: undefined, response: { ok: true } });

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkGen,
  conversationsPost: () => ok({ id: "conv-1" }),
  messagesPost: (opts: PostCall) => {
    postCalls.push(opts);
    return ok({});
  },
  messagesGet: () =>
    ok({
      processing: false,
      messages: [
        { role: "assistant", contentBlocks: [{ type: "text", text: "Done." }] },
      ],
    }),
  conversationsByIdArchivePost: (opts: {
    path: { assistant_id: string; id: string };
  }) => {
    archiveCalls.push(opts);
    return ok({});
  },
}));
mock.module("@/lib/sentry/capture-error", () => ({ captureError: () => {} }));

const { runIdentityRewrite } = await import("./run-identity-rewrite");

afterEach(() => {
  postCalls = [];
  archiveCalls = [];
});

describe("runIdentityRewrite", () => {
  test("posts the rewrite prompt hidden and archives the side conversation", async () => {
    await runIdentityRewrite({
      assistantId: "ast-1",
      content: "<system-message>rewrite</system-message>",
      title: "Updating personality",
      context: "test",
    });

    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.path).toEqual({ assistant_id: "ast-1" });
    expect(postCalls[0]?.body.conversationId).toBe("conv-1");
    expect(postCalls[0]?.body.hidden).toBe(true);

    expect(archiveCalls).toHaveLength(1);
    expect(archiveCalls[0]?.path).toEqual({
      assistant_id: "ast-1",
      id: "conv-1",
    });
  });
});
