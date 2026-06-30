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
import { client as daemonClient } from "@/generated/daemon/client.gen";
import {
  fetchConversationMessages,
  getChatHistory,
  mapRuntimeToolCalls,
  normalizeContentBlocks,
  normalizeContentOrder,
  postChatMessage,
  RECONCILE_LATEST_PAGE_LIMIT,
} from "@/domains/chat/api/messages";
import { messageText } from "@/domains/chat/utils/message-test-helpers";
import type {
  ConversationContentBlock,
  ConversationMessage,
  ConversationMessageToolCall,
} from "@vellumai/assistant-api";

function wireMessage(
  overrides: Partial<ConversationMessage>,
): ConversationMessage {
  return {
    id: "m1",
    role: "assistant",
    timestamp: "2026-05-15T12:34:56.000Z",
    attachments: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Spy setup — replace client.post per-test, restore after
// ---------------------------------------------------------------------------

let capturedBody: Record<string, unknown> | null = null;
let nextPostResult: { data: unknown; error: unknown; response: Response };
const originalPost = daemonClient.post;
const originalGet = daemonClient.get;

beforeEach(() => {
  capturedBody = null;
  nextPostResult = {
    data: { accepted: true, messageId: "msg-1" },
    error: null,
    response: new Response(null, { status: 200 }),
  };
  daemonClient.post = mock(
    async (options: { body?: Record<string, unknown> }) => {
      capturedBody = options.body ?? null;
      return nextPostResult;
    },
  ) as typeof daemonClient.post;
});

afterEach(() => {
  daemonClient.post = originalPost;
  daemonClient.get = originalGet;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("postChatMessage — onboarding wire format", () => {
  test("includes googleConnected and googleScopes when provided", async () => {
    await postChatMessage("assistant-1", "conv-key", "Hello", [], {
      tools: [],
      tasks: [],
      tone: "warm",
      googleConnected: true,
      googleScopes: ["https://mail.google.com/"],
    });

    expect(capturedBody).not.toBeNull();
    const onboarding = (capturedBody as Record<string, unknown>)
      .onboarding as Record<string, unknown>;
    expect(onboarding).not.toBeNull();
    expect(onboarding.googleConnected).toBe(true);
    expect(onboarding.googleScopes).toEqual(["https://mail.google.com/"]);
  });

  test("omits googleConnected and googleScopes when not provided", async () => {
    await postChatMessage("assistant-1", "conv-key", "Hello", [], {
      tools: [],
      tasks: [],
      tone: "grounded",
    });

    const onboarding = (capturedBody as Record<string, unknown>)
      .onboarding as Record<string, unknown>;
    expect(onboarding.googleConnected).toBeUndefined();
    expect(onboarding.googleScopes).toBeUndefined();
  });

  test("omits the entire onboarding key when onboarding param is absent", async () => {
    await postChatMessage("assistant-1", "conv-key", "Hello");

    expect(capturedBody).not.toBeNull();
    expect(
      (capturedBody as Record<string, unknown>).onboarding,
    ).toBeUndefined();
  });
});

describe("postChatMessage — clientMessageId wire format", () => {
  test("sends the client nonce as the idempotency key when provided", async () => {
    await postChatMessage(
      "assistant-1",
      "conv-key",
      "Hello",
      [],
      undefined,
      "nonce-123",
    );

    expect(capturedBody).not.toBeNull();
    expect((capturedBody as Record<string, unknown>).clientMessageId).toBe(
      "nonce-123",
    );
  });

  test("omits clientMessageId when absent so pre-idempotency daemons are unaffected", async () => {
    await postChatMessage("assistant-1", "conv-key", "Hello");

    expect(capturedBody).not.toBeNull();
    expect(
      (capturedBody as Record<string, unknown>).clientMessageId,
    ).toBeUndefined();
  });
});

describe("postChatMessage — enabledPlugins wire format", () => {
  test("includes an explicit plugin selection verbatim", async () => {
    await postChatMessage(
      "assistant-1",
      "conv-key",
      "Hello",
      [],
      undefined,
      undefined,
      undefined,
      ["alpha", "zeta"],
    );

    expect(
      (capturedBody as Record<string, unknown>).enabledPlugins,
    ).toEqual(["alpha", "zeta"]);
  });

  test("includes an explicit empty selection (user disabled every plugin)", async () => {
    await postChatMessage(
      "assistant-1",
      "conv-key",
      "Hello",
      [],
      undefined,
      undefined,
      undefined,
      [],
    );

    // An empty array is a genuine "no plugins for this chat" selection, not a
    // missing one — it must reach the daemon, unlike the omitted-default case.
    expect((capturedBody as Record<string, unknown>).enabledPlugins).toEqual(
      [],
    );
  });

  test("omits enabledPlugins when undefined (untouched default)", async () => {
    await postChatMessage("assistant-1", "conv-key", "Hello");

    expect(
      (capturedBody as Record<string, unknown>).enabledPlugins,
    ).toBeUndefined();
  });

  test("omits enabledPlugins when null", async () => {
    await postChatMessage(
      "assistant-1",
      "conv-key",
      "Hello",
      [],
      undefined,
      undefined,
      undefined,
      null,
    );

    expect(
      (capturedBody as Record<string, unknown>).enabledPlugins,
    ).toBeUndefined();
  });
});

describe("normalizeContentOrder", () => {
  test("converts string-format entries to objects", () => {
    const result = normalizeContentOrder(["text:0", "tool:1", "surface:2"]);
    expect(result).toEqual([
      { type: "text", id: "0" },
      { type: "tool", id: "1" },
      { type: "surface", id: "2" },
    ]);
  });

  test("passes through already-object entries unchanged", () => {
    const input = [
      { type: "text", id: "0" },
      { type: "toolCall", id: "abc-123" },
    ];
    const result = normalizeContentOrder(input);
    expect(result).toEqual(input);
  });

  test("handles mixed string and object entries", () => {
    const result = normalizeContentOrder([
      "text:0",
      { type: "toolCall", id: "tc-1" },
      "tool:1",
    ]);
    expect(result).toEqual([
      { type: "text", id: "0" },
      { type: "toolCall", id: "tc-1" },
      { type: "tool", id: "1" },
    ]);
  });

  test("handles thinking entries", () => {
    const result = normalizeContentOrder(["thinking:0", "text:0"]);
    expect(result).toEqual([
      { type: "thinking", id: "0" },
      { type: "text", id: "0" },
    ]);
  });

  test("returns undefined for empty or missing input", () => {
    expect(normalizeContentOrder(undefined)).toBeUndefined();
    expect(normalizeContentOrder([])).toBeUndefined();
  });

  test("skips malformed entries", () => {
    const result = normalizeContentOrder([
      "text:0",
      "nocolon",
      42 as unknown as string,
      null as unknown as string,
      { type: 123, id: "bad" } as unknown as { type: string; id: string },
      "tool:1",
    ]);
    expect(result).toEqual([
      { type: "text", id: "0" },
      { type: "tool", id: "1" },
    ]);
  });
});

describe("normalizeContentBlocks", () => {
  test("returns the daemon's contentBlocks projection verbatim when present", () => {
    // GIVEN a wire message that already carries a unified contentBlocks list
    const contentBlocks: ConversationContentBlock[] = [
      { type: "thinking", thinking: "reasoning" },
      { type: "text", text: "hello" },
    ];
    const message = wireMessage({
      contentBlocks,
      // AND stale positional arrays that should be ignored in favour of blocks
      textSegments: ["different"],
      thinkingSegments: ["different reasoning"],
      contentOrder: ["text:0"],
    });

    // WHEN we resolve the message's content blocks
    const result = normalizeContentBlocks(message);

    // THEN the wire projection is returned unchanged (same reference)
    expect(result).toBe(contentBlocks);
  });

  test("trusts an empty contentBlocks array over reconstructing from positional arrays", () => {
    // GIVEN a daemon that emits the projection but for a contentless message,
    // so contentBlocks is a defined-but-empty array
    const contentBlocks: ConversationContentBlock[] = [];
    const message = wireMessage({
      contentBlocks,
      // AND positional arrays that would otherwise be reconstructed from
      contentOrder: ["text:0"],
      textSegments: ["should be ignored"],
    });

    // WHEN we resolve the message's content blocks
    const result = normalizeContentBlocks(message);

    // THEN the authoritative empty projection wins; positional arrays are not
    // reconstructed (a sent-but-empty field is a genuinely contentless message,
    // not a missing projection)
    expect(result).toBe(contentBlocks);
  });

  test("reconstructs blocks from positional arrays for daemons that omit them", () => {
    // GIVEN a pre-projection message carrying only positional arrays
    const toolCall: ConversationMessageToolCall = {
      id: "call-a",
      name: "bash",
      input: {},
    };
    const surface = { surfaceId: "s0", surfaceType: "card", data: {} };
    const attachment = {
      id: "att-0",
      filename: "file.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      kind: "document",
    };
    const message = wireMessage({
      contentOrder: [
        "thinking:0",
        "tool:0",
        "text:0",
        "surface:0",
        "attachment:0",
      ],
      thinkingSegments: ["reasoning"],
      textSegments: ["hello"],
      toolCalls: [toolCall],
      surfaces: [surface],
      attachments: [attachment],
    });

    // WHEN we resolve the message's content blocks
    const result = normalizeContentBlocks(message);

    // THEN an equivalent discriminated-union list is built in contentOrder order
    expect(result).toEqual([
      { type: "thinking", thinking: "reasoning" },
      { type: "tool_use", toolCall },
      { type: "text", text: "hello" },
      { type: "surface", surface },
      { type: "attachment", attachment },
    ]);
  });

  test("synthesizes a positional tool-call id for pre-0.8.8 id-less tool calls", () => {
    // GIVEN a pre-projection message whose wire tool call omits `id`, exactly
    // as daemons predating the provider tool-use id do
    const message = wireMessage({
      id: "msg-7",
      contentOrder: ["tool:0", "tool:1"],
      toolCalls: [
        { name: "bash", input: {} },
        { name: "edit", input: {} },
      ],
    });

    // WHEN we reconstruct the blocks
    const result = normalizeContentBlocks(message);

    // THEN each tool_use block carries the same stable id the positional
    // `mapRuntimeToolCalls` path synthesizes, so the block-native renderer can
    // key it instead of dropping it
    expect(result).toEqual([
      { type: "tool_use", toolCall: { name: "bash", input: {}, id: "tool-history-msg-7-0" } },
      { type: "tool_use", toolCall: { name: "edit", input: {}, id: "tool-history-msg-7-1" } },
    ]);
  });

  test("strips inlined [File attachment] summaries and drops fully-consumed text", () => {
    // GIVEN a text segment whose only content is an attachment summary line
    const message = wireMessage({
      contentOrder: ["text:0", "text:1"],
      textSegments: [
        "real body",
        "[File attachment] file.pdf, type=application/pdf",
      ],
    });

    // WHEN we reconstruct the blocks
    const result = normalizeContentBlocks(message);

    // THEN the summary-only segment is dropped and the real body survives
    expect(result).toEqual([{ type: "text", text: "real body" }]);
  });

  test("returns undefined when neither blocks nor contentOrder are present", () => {
    // GIVEN a message with no ordering information at all
    const message = wireMessage({ textSegments: ["orphan"] });

    // WHEN we resolve the message's content blocks
    // THEN there is nothing to project
    expect(normalizeContentBlocks(message)).toBeUndefined();
  });
});

describe("getChatHistory", () => {
  test("uses shared runtime mapping for Slack metadata and timestamps", async () => {
    const slackMessage = {
      channelId: "C123ABCDEF",
      channelName: "triage",
      channelTs: "1710000000.000200",
      threadTs: "1710000000.000100",
      sender: {
        id: "U123",
        displayName: "Ada Lovelace",
        username: "ada",
        avatarUrl: "https://example.com/avatar.png",
        isBot: false,
      },
      messageLink: {
        appUrl:
          "slack://channel?team=T123&id=C123ABCDEF&message=1710000000.000200",
        webUrl:
          "https://example.slack.com/archives/C123ABCDEF/p1710000000000200",
      },
    };

    daemonClient.get = mock(async () => ({
      data: {
        messages: [
          {
            id: "msg-slack",
            role: "user",
            textSegments: [
              "Slack reply",
              "[File attachment] file.pdf, type=application/pdf",
            ],
            contentOrder: ["text:0", "text:1"],
            slackMessage,
            timestamp: "2026-05-15T12:34:56.000Z",
          },
        ],
      },
      error: null,
      response: new Response(null, { status: 200 }),
    })) as typeof daemonClient.get;

    const result = await getChatHistory("assistant-1", "conv-key");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.messages[0]).toMatchObject({
      id: "msg-slack",
      role: "user",
      slackMessage,
      timestamp: Date.parse("2026-05-15T12:34:56.000Z"),
    });
    expect(messageText(result.messages[0])).toBe("Slack reply");
  });
});

describe("fetchConversationMessages — request shape", () => {
  function captureQuery(): { current: Record<string, unknown> | null } {
    const captured: { current: Record<string, unknown> | null } = {
      current: null,
    };
    daemonClient.get = mock(
      async (options: { query?: Record<string, unknown> }) => {
        captured.current = options.query ?? null;
        return {
          data: { messages: [], seq: 7 },
          error: null,
          response: new Response(null, { status: 200 }),
        };
      },
    ) as typeof daemonClient.get;
    return captured;
  }

  test("downloads the full conversation when no page limit is given", async () => {
    const captured = captureQuery();

    await fetchConversationMessages("assistant-1", "conv-1");

    expect(captured.current).toEqual({ conversationId: "conv-1" });
    // Full-snapshot callers (the inspector) must not page.
    expect(captured.current).not.toHaveProperty("page");
    expect(captured.current).not.toHaveProperty("limit");
  });

  test("requests only the latest page when a page limit is given", async () => {
    const captured = captureQuery();

    const result = await fetchConversationMessages("assistant-1", "conv-1", {
      latestPageLimit: RECONCILE_LATEST_PAGE_LIMIT,
    });

    expect(captured.current).toEqual({
      conversationId: "conv-1",
      page: "latest",
      limit: RECONCILE_LATEST_PAGE_LIMIT,
    });
    // The paginated response still carries the snapshot watermark the
    // reconcile/seq callers depend on.
    expect(result?.seq).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// postChatMessage — daemon error envelope handling
// ---------------------------------------------------------------------------
//
// The daemon returns secret-ingress rejections as 422 with a non-standard
// envelope: `{ accepted: false, error: "secret_blocked", message: "...",
// detectedTypes: [...] }`. The `error` field is a bare code string, not a
// user-facing detail. Regression-guard the extraction order so that:
//   - `code` picks up "secret_blocked"
//   - `detail` picks up the friendly `message`, never the bare code
// Without this, the UI used to render "secret_blocked" as the user message.

describe("postChatMessage — daemon error envelope handling", () => {
  test("422 with bare-string error+message: code=string, detail=message", async () => {
    nextPostResult = {
      data: null,
      error: {
        accepted: false,
        error: "secret_blocked",
        message:
          "Your message looks like it contains a secret. Please remove it before sending.",
        detectedTypes: ["api_key"],
      },
      response: new Response(null, { status: 422 }),
    };

    const result = await postChatMessage("asst-1", "conv-key", "secret token");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure result");
    expect(result.status).toBe(422);
    expect(result.error.code).toBe("secret_blocked");
    expect(result.error.detail).toBe(
      "Your message looks like it contains a secret. Please remove it before sending.",
    );
  });

  test("standard detail-only envelope still surfaces detail", async () => {
    nextPostResult = {
      data: null,
      error: { detail: "Rate limited. Try again shortly." },
      response: new Response(null, { status: 429 }),
    };

    const result = await postChatMessage("asst-1", "conv-key", "hi");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure result");
    expect(result.status).toBe(429);
    expect(result.error.detail).toBe("Rate limited. Try again shortly.");
    expect(result.error.code).toBeUndefined();
  });

  test("nested error.code wins over bare error string for code", async () => {
    nextPostResult = {
      data: null,
      error: {
        // Both a nested error object AND a bare error string. Nested code
        // takes priority — bare string is only a last-resort code fallback.
        error: { code: "RATE_LIMITED", message: "Slow down." },
      },
      response: new Response(null, { status: 429 }),
    };

    const result = await postChatMessage("asst-1", "conv-key", "hi");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure result");
    expect(result.error.code).toBe("RATE_LIMITED");
    expect(result.error.detail).toBe("Slow down.");
  });

  test("falls back to HTTP status when no detail-bearing field present", async () => {
    nextPostResult = {
      data: null,
      error: {},
      response: new Response(null, { status: 503 }),
    };

    const result = await postChatMessage("asst-1", "conv-key", "hi");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure result");
    expect(result.error.detail).toBe("HTTP 503");
  });
});

describe("mapRuntimeToolCalls — confirmationDecision", () => {
  test("omits confirmationDecision entirely when the wire row lacks it", () => {
    // GIVEN a history tool call with no confirmationDecision on the wire
    const wire: ConversationMessageToolCall = {
      name: "bash",
      input: { command: "ls" },
      result: "ok",
    };

    // WHEN it is projected onto the rendered tool call
    const [mapped] = mapRuntimeToolCalls([wire], "msg-1");

    // THEN the key is absent — not materialized as `undefined` — so a later
    // reconcile spread can't clobber a locally-set decision.
    expect(mapped).not.toHaveProperty("confirmationDecision");
  });

  test("preserves a confirmationDecision carried on the wire row", () => {
    // GIVEN a history row carrying a recorded confirmation outcome
    const wire: ConversationMessageToolCall = {
      name: "bash",
      input: {},
      confirmationDecision: "denied",
    };

    // WHEN it is projected onto a rendered tool call
    const [mapped] = mapRuntimeToolCalls([wire], "msg-1");

    // THEN the decision survives the projection straight from the wire
    expect(mapped!.confirmationDecision).toBe("denied");
  });
});

describe("mapRuntimeToolCalls — id", () => {
  test("uses the wire-provided provider tool-use id when present", () => {
    // GIVEN a history tool call carrying the provider tool-use id on the wire
    const wire: ConversationMessageToolCall = {
      id: "toolu_abc123",
      name: "bash",
      input: { command: "ls" },
      result: "ok",
    };

    // WHEN it is projected onto the rendered tool call
    const [mapped] = mapRuntimeToolCalls([wire], "msg-1");

    // THEN it keys by the same id the live `tool_use_start` stream uses, so
    // reconcile can match snapshot and stream tool calls — no positional id.
    expect(mapped!.id).toBe("toolu_abc123");
  });

  test("falls back to a positional id when the wire omits id", () => {
    // GIVEN history rows from a daemon predating the wire `id` field
    const wire: ConversationMessageToolCall[] = [
      { name: "bash", input: {}, result: "a" },
      { name: "bash", input: {}, result: "b" },
    ];

    // WHEN they are projected onto rendered tool calls
    const [first, second] = mapRuntimeToolCalls(wire, "msg-1");

    // THEN each gets a stable synthesized positional id
    expect(first!.id).toBe("tool-history-msg-1-0");
    expect(second!.id).toBe("tool-history-msg-1-1");
  });
});
