/**
 * Tests for `postChatMessage` wire format, specifically the
 * googleConnected and googleScopes fields added for the
 * Google Connect Scan feature.
 *
 * Uses direct method spying on the imported client instead of
 * mock.module to avoid polluting the module registry for other test
 * files in the same Bun process.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { client } from "@/domains/chat/lib/client.js";
import { postChatMessage } from "@/domains/chat/lib/messages.js";

// ---------------------------------------------------------------------------
// Spy setup — replace client.post per-test, restore after
// ---------------------------------------------------------------------------

let capturedBody: Record<string, unknown> | null = null;
let nextPostResult: { data: unknown; error: unknown; response: Response };
const originalPost = client.post;

beforeEach(() => {
  capturedBody = null;
  nextPostResult = {
    data: { accepted: true, messageId: "msg-1" },
    error: null,
    response: new Response(null, { status: 200 }),
  };
  client.post = mock(
    async (options: { body?: Record<string, unknown> }) => {
      capturedBody = options.body ?? null;
      return nextPostResult;
    },
  ) as typeof client.post;
});

afterEach(() => {
  client.post = originalPost;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("postChatMessage — onboarding wire format", () => {
  test("includes googleConnected and googleScopes when provided", async () => {
    await postChatMessage(
      "assistant-1",
      "conv-key",
      "Hello",
      [],
      {
        tools: [],
        tasks: [],
        tone: "warm",
        googleConnected: true,
        googleScopes: ["https://mail.google.com/"],
      },
    );

    expect(capturedBody).not.toBeNull();
    const onboarding = (capturedBody as Record<string, unknown>)
      .onboarding as Record<string, unknown>;
    expect(onboarding).not.toBeNull();
    expect(onboarding.googleConnected).toBe(true);
    expect(onboarding.googleScopes).toEqual(["https://mail.google.com/"]);
  });

  test("omits googleConnected and googleScopes when not provided", async () => {
    await postChatMessage(
      "assistant-1",
      "conv-key",
      "Hello",
      [],
      {
        tools: [],
        tasks: [],
        tone: "grounded",
      },
    );

    const onboarding = (capturedBody as Record<string, unknown>)
      .onboarding as Record<string, unknown>;
    expect(onboarding.googleConnected).toBeUndefined();
    expect(onboarding.googleScopes).toBeUndefined();
  });

  test("omits the entire onboarding key when onboarding param is absent", async () => {
    await postChatMessage("assistant-1", "conv-key", "Hello");

    expect(capturedBody).not.toBeNull();
    expect((capturedBody as Record<string, unknown>).onboarding).toBeUndefined();
  });
});
