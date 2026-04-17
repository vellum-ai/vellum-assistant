import { describe, expect, test } from "bun:test";

import type { ContextWindowConfig } from "../config/types.js";
import { estimateTextTokens } from "../context/token-estimator.js";
import {
  CONTEXT_SUMMARY_MARKER,
  ContextWindowManager,
  createContextSummaryMessage,
  getSummaryFromContextMessage,
} from "../context/window-manager.js";
import type {
  Message,
  Provider,
  ProviderResponse,
} from "../providers/types.js";

function makeConfig(
  overrides: Partial<ContextWindowConfig> = {},
): ContextWindowConfig {
  return {
    enabled: true,
    maxInputTokens: 450,
    targetBudgetRatio: 0.67,
    compactThreshold: 0.6,
    summaryBudgetRatio: 0.05,
    overflowRecovery: {
      enabled: true,
      safetyMarginRatio: 0.05,
      maxAttempts: 3,
      interactiveLatestTurnCompression: "summarize",
      nonInteractiveLatestTurnCompression: "truncate",
    },
    ...overrides,
  };
}

function createProvider(
  fn: (messages: Message[]) => ProviderResponse | Promise<ProviderResponse>,
): Provider {
  return {
    name: "mock",
    async sendMessage(messages: Message[]): Promise<ProviderResponse> {
      return fn(messages);
    },
  };
}

function message(role: "user" | "assistant", text: string): Message {
  return { role, content: [{ type: "text", text }] };
}

describe("ContextWindowManager", () => {
  test("skips compaction when estimated tokens are below threshold", async () => {
    const provider = createProvider(() => {
      throw new Error("should not be called");
    });
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config: makeConfig(),
    });
    const history = [message("user", "hello"), message("assistant", "hi")];

    const result = await manager.maybeCompact(history);
    expect(result.compacted).toBe(false);
    expect(result.messages).toEqual(history);
    expect(result.reason).toBe("below compaction threshold");
  });

  test("compacts old turns and keeps recent user turns", async () => {
    let summaryCalls = 0;
    const provider = createProvider(() => {
      summaryCalls += 1;
      return {
        content: [
          { type: "text", text: `## Goals\n- summary call ${summaryCalls}` },
        ],
        model: "mock-model",
        usage: { inputTokens: 100, outputTokens: 25 },
        stopReason: "end_turn",
      };
    });
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config: makeConfig({ maxInputTokens: 600 }),
    });
    const long = "x".repeat(240);
    const history: Message[] = [
      message("user", `u1 ${long}`),
      message("assistant", `a1 ${long}`),
      message("user", `u2 ${long}`),
      message("assistant", `a2 ${long}`),
      message("user", `u3 ${long}`),
      message("assistant", `a3 ${long}`),
    ];

    const result = await manager.maybeCompact(history);

    expect(result.compacted).toBe(true);
    expect(result.compactedMessages).toBeGreaterThan(0);
    expect(result.summaryCalls).toBe(summaryCalls);
    expect(result.summaryInputTokens).toBeGreaterThan(0);
    expect(result.summaryOutputTokens).toBeGreaterThan(0);
    expect(result.messages[0].role).toBe("user");
    expect(
      getSummaryFromContextMessage(result.messages[0])?.length,
    ).toBeGreaterThan(0);

    const userTexts = result.messages
      .filter((m) => m.role === "user")
      .map((m) => (m.content[0].type === "text" ? m.content[0].text : ""));
    expect(userTexts.some((text) => text.startsWith("u1 "))).toBe(false);
    expect(userTexts.some((text) => text.startsWith("u2 "))).toBe(true);
    expect(userTexts.some((text) => text.startsWith("u3 "))).toBe(true);
  });

  test("returns cache-aware summary usage from single-pass compaction", async () => {
    const provider = createProvider(() => {
      return {
        content: [
          { type: "text", text: `## Goals\n- summary of full transcript` },
        ],
        model: "claude-opus-4-6",
        usage: {
          inputTokens: 5_000,
          outputTokens: 80,
          cacheCreationInputTokens: 50,
          cacheReadInputTokens: 200,
        },
        rawResponse: {
          usage: {
            cache_creation: {
              ephemeral_5m_input_tokens: 50,
              ephemeral_1h_input_tokens: 0,
            },
            cache_read_input_tokens: 200,
          },
        },
        stopReason: "end_turn",
      };
    });
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config: makeConfig({
        maxInputTokens: 7_000,
        targetBudgetRatio: 0.41,
      }),
    });
    const long = "q".repeat(6_000);
    const history: Message[] = [
      message("user", `u1 ${long}`),
      message("assistant", `a1 ${long}`),
      message("user", `u2 ${long}`),
      message("assistant", `a2 ${long}`),
      message("user", `u3 ${long}`),
    ];

    const result = await manager.maybeCompact(history);

    expect(result.compacted).toBe(true);
    expect(result.summaryCalls).toBe(1);
    expect(result.summaryCacheCreationInputTokens).toBe(50);
    expect(result.summaryCacheReadInputTokens).toBe(200);
    expect(result.summaryRawResponses).toHaveLength(1);
    expect(result.summaryRawResponses?.[0]).toMatchObject({
      usage: {
        cache_creation: { ephemeral_5m_input_tokens: 50 },
        cache_read_input_tokens: 200,
      },
    });
  });

  test("updates an existing summary message instead of nesting summaries", async () => {
    const provider = createProvider(() => ({
      content: [{ type: "text", text: "## Goals\n- updated summary" }],
      model: "mock-model",
      usage: { inputTokens: 50, outputTokens: 10 },
      stopReason: "end_turn",
    }));
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config: makeConfig({
        maxInputTokens: 300,
        targetBudgetRatio: 0.58,
      }),
    });
    const long = "y".repeat(220);
    const history: Message[] = [
      createContextSummaryMessage("## Goals\n- old summary"),
      message("user", `older ${long}`),
      message("assistant", `reply ${long}`),
      message("user", `latest ${long}`),
    ];

    const result = await manager.maybeCompact(history);
    expect(result.compacted).toBe(true);
    expect(result.messages.length).toBeLessThan(history.length + 1);
    expect(getSummaryFromContextMessage(result.messages[0])).toContain(
      "updated summary",
    );
    expect(
      result.messages.filter(
        (m) =>
          m.role === "user" &&
          m.content.some(
            (block) =>
              block.type === "text" &&
              block.text.startsWith(CONTEXT_SUMMARY_MARKER),
          ),
      ),
    ).toHaveLength(1);
  });

  test("falls back to local summary when provider summarization fails", async () => {
    const provider = createProvider(async () => {
      throw new Error("provider unavailable");
    });
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config: makeConfig({
        maxInputTokens: 260,
        targetBudgetRatio: 0.59,
      }),
    });
    const long = "z".repeat(220);
    const history = [
      message("user", `task ${long}`),
      message("assistant", `result ${long}`),
      message("user", `followup ${long}`),
    ];

    const result = await manager.maybeCompact(history);
    expect(result.compacted).toBe(true);
    expect(result.summaryCalls).toBeGreaterThan(0);
    expect(result.summaryInputTokens).toBe(0);
    expect(result.summaryOutputTokens).toBe(0);
    expect(result.summaryModel).toBe("");
    expect(result.summaryText).toContain("## Recent Progress");
  });

  test("serializes file blocks for summary chunks", async () => {
    const prompts: string[] = [];
    const provider = createProvider((messages) => {
      for (const block of messages[0]?.content ?? []) {
        if (block.type === "text") {
          prompts.push(block.text);
        }
      }
      return {
        content: [{ type: "text", text: "## Goals\n- file summarized" }],
        model: "mock-model",
        usage: { inputTokens: 60, outputTokens: 12 },
        stopReason: "end_turn",
      };
    });
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config: makeConfig({
        maxInputTokens: 550,
        targetBudgetRatio: 0.59,
      }),
    });
    const long = "f".repeat(500);
    const history: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "file",
            source: {
              type: "base64",
              media_type: "application/pdf",
              filename: "spec.pdf",
              data: "a".repeat(4096),
            },
            extracted_text: "Critical requirement from attached spec.",
          },
        ],
      },
      message("assistant", `ack ${long}`),
      message("user", `followup ${long}`),
    ];

    const result = await manager.maybeCompact(history);
    expect(result.compacted).toBe(true);

    const combinedPrompts = prompts.join("\n");
    expect(combinedPrompts).toContain("file: spec.pdf");
    expect(combinedPrompts).toContain("application/pdf");
    expect(combinedPrompts).toContain(
      "Critical requirement from attached spec.",
    );
    expect(combinedPrompts).not.toContain("unknown_block");
  });

  test("passes image blocks to summarizer instead of text metadata", async () => {
    const receivedBlocks: { type: string; mediaType?: string }[] = [];
    const provider = createProvider((messages) => {
      for (const block of messages[0]?.content ?? []) {
        if (block.type === "image") {
          receivedBlocks.push({
            type: "image",
            mediaType: (block as { source: { media_type: string } }).source
              .media_type,
          });
        } else if (block.type === "text") {
          receivedBlocks.push({ type: "text" });
        }
      }
      return {
        content: [
          {
            type: "text",
            text: "## Goals\n- described image: a photo of a cat",
          },
        ],
        model: "mock-model",
        usage: { inputTokens: 100, outputTokens: 20 },
        stopReason: "end_turn",
      };
    });
    // Use a large enough maxInputTokens so the image fits in the summarizer
    // budget after accounting for overhead (system prompt, scaffolding, output).
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "sys",
      config: makeConfig({
        maxInputTokens: 5000,
        compactThreshold: 0.3,
        targetBudgetRatio: 0.2,
      }),
    });
    const long = "x".repeat(4000);
    const history: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "iVBORw0KGgo=",
            },
          },
        ],
      },
      message("assistant", `a1 ${long}`),
      message("user", `u2 ${long}`),
    ];

    const result = await manager.maybeCompact(history);
    expect(result.compacted).toBe(true);

    // The summarizer should have received actual image blocks, not text stubs.
    const imageBlocks = receivedBlocks.filter((b) => b.type === "image");
    expect(imageBlocks.length).toBe(1);
    expect(imageBlocks[0].mediaType).toBe("image/png");
  });

  test("passes tool_result images to summarizer", async () => {
    const receivedImageCount = { count: 0 };
    const provider = createProvider((messages) => {
      for (const block of messages[0]?.content ?? []) {
        if (block.type === "image") {
          receivedImageCount.count++;
        }
      }
      return {
        content: [
          { type: "text", text: "## Goals\n- summarized tool output images" },
        ],
        model: "mock-model",
        usage: { inputTokens: 100, outputTokens: 20 },
        stopReason: "end_turn",
      };
    });
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "sys",
      config: makeConfig({
        maxInputTokens: 5000,
        compactThreshold: 0.3,
        targetBudgetRatio: 0.2,
      }),
    });
    const long = "x".repeat(2000);
    const history: Message[] = [
      message("assistant", "let me read that file"),
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_1",
            content: "file contents",
            contentBlocks: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/jpeg",
                  data: "iVBORw0KGgo=",
                },
              },
            ],
            is_error: false,
          } as import("../providers/types.js").ToolResultContent,
        ],
      },
      message("user", `followup ${long}`),
      message("assistant", `response ${long}`),
      message("user", `final ${long}`),
    ];

    const result = await manager.maybeCompact(history);
    expect(result.compacted).toBe(true);
    expect(receivedImageCount.count).toBe(1);
  });

  test("counts compacted persisted messages including tool-result user turns", async () => {
    const provider = createProvider(() => ({
      content: [{ type: "text", text: "## Goals\n- compacted summary" }],
      model: "mock-model",
      usage: { inputTokens: 75, outputTokens: 20 },
      stopReason: "end_turn",
    }));
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config: makeConfig({
        maxInputTokens: 320,
        targetBudgetRatio: 0.58,
      }),
    });
    const long = "k".repeat(220);
    const history: Message[] = [
      message("user", `u1 ${long}`),
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "read_file",
            input: { path: "/tmp/a" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "contents" },
        ],
      },
      message("assistant", `a1 ${long}`),
      message("user", `u2 ${long}`),
    ];

    const result = await manager.maybeCompact(history);
    expect(result.compacted).toBe(true);
    expect(result.compactedMessages).toBe(4);
    // Tool-result-only user messages have DB counterparts and must be
    // counted so contextCompactedMessageCount indexes the DB correctly.
    expect(result.compactedPersistedMessages).toBe(4);
  });

  test("adjusts keep boundary to preserve tool_use/tool_result pairs", async () => {
    const provider = createProvider(() => ({
      content: [{ type: "text", text: "## Goals\n- compacted summary" }],
      model: "mock-model",
      usage: { inputTokens: 75, outputTokens: 20 },
      stopReason: "end_turn",
    }));
    // Configure budget so compaction keeps only the last user turn,
    // which would normally split the tool pair because the last user
    // turn start is a mixed message (tool_result + text) whose matching
    // tool_use lives in the preceding assistant message.
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config: makeConfig({
        maxInputTokens: 320,
        targetBudgetRatio: 0.58,
      }),
    });
    const long = "k".repeat(220);
    const history: Message[] = [
      message("user", `u1 ${long}`), // index 0: old user turn (long)
      message("assistant", `a1 ${long}`), // index 1: assistant reply (long)
      message("user", `u2 ${long}`), // index 2: second user turn (long)
      {
        // index 3: assistant with tool_use
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "read_file",
            input: { path: "/tmp/a" },
          },
        ],
      },
      {
        // index 4: user with tool_result AND text (mixed = user turn start)
        // Without adjustForToolPairs, the raw boundary would land here,
        // orphaning the tool_result from its tool_use at index 3.
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "file contents" },
          { type: "text", text: "thanks, now continue" },
        ],
      },
    ];

    const result = await manager.maybeCompact(history);
    expect(result.compacted).toBe(true);
    // The kept messages must include the tool_use assistant message (index 3)
    // and tool_result user message (index 4) as a pair, not split them.
    // Verify no orphaned tool_result blocks exist in the kept messages.
    const keptMessages = result.messages;
    for (let i = 0; i < keptMessages.length; i++) {
      const msg = keptMessages[i];
      if (msg.role !== "user") continue;
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          // Every tool_result must have a matching tool_use in a preceding assistant message
          const toolUseId = (block as { tool_use_id: string }).tool_use_id;
          const hasMatchingToolUse = keptMessages
            .slice(0, i)
            .some(
              (prev) =>
                prev.role === "assistant" &&
                prev.content.some(
                  (b) =>
                    b.type === "tool_use" &&
                    (b as { id: string }).id === toolUseId,
                ),
            );
          expect(hasMatchingToolUse).toBe(true);
        }
      }
    }
  });

  test("counts mixed tool_result+text user messages as persisted", async () => {
    const provider = createProvider(() => ({
      content: [{ type: "text", text: "## Goals\n- mixed summary" }],
      model: "mock-model",
      usage: { inputTokens: 75, outputTokens: 20 },
      stopReason: "end_turn",
    }));
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config: makeConfig({
        maxInputTokens: 320,
        targetBudgetRatio: 0.58,
      }),
    });
    const long = "k".repeat(220);
    // Simulates a merged user message (repairHistory merges consecutive same-role
    // messages), resulting in a user turn with both tool_result and text blocks.
    const history: Message[] = [
      message("user", `u1 ${long}`),
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "read_file",
            input: { path: "/tmp/a" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "contents" },
          { type: "text", text: `follow-up question ${long}` },
        ],
      },
      message("assistant", `a1 ${long}`),
      message("user", `u2 ${long}`),
    ];

    const result = await manager.maybeCompact(history);
    expect(result.compacted).toBe(true);
    // The mixed user message should be counted as persisted (4 = u1 + mixed + a_tooluse + a1)
    expect(result.compactedPersistedMessages).toBe(4);
  });

  test("returns cache-aware usage metadata for compaction summaries", async () => {
    const rawResponse = {
      usage: {
        cache_creation: { ephemeral_5m_input_tokens: 120 },
        cache_read_input_tokens: 340,
      },
    };
    const provider = createProvider(() => ({
      content: [{ type: "text", text: "## Goals\n- cache-aware summary" }],
      model: "claude-opus-4-6",
      usage: {
        inputTokens: 500,
        outputTokens: 22,
        cacheCreationInputTokens: 120,
        cacheReadInputTokens: 340,
      },
      rawResponse,
      stopReason: "end_turn",
    }));
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config: makeConfig({
        maxInputTokens: 2600,
        targetBudgetRatio: 0.63,
      }),
    });
    const long = "c".repeat(5000);
    const history: Message[] = [
      message("user", `u1 ${long}`),
      message("assistant", `a1 ${long}`),
      message("user", `u2 ${long}`),
    ];

    const result = await manager.maybeCompact(history);

    expect(result.compacted).toBe(true);
    expect(result.summaryCalls).toBe(1);
    expect(result.summaryInputTokens).toBe(500);
    expect(result.summaryCacheCreationInputTokens).toBe(120);
    expect(result.summaryCacheReadInputTokens).toBe(340);
    expect(result.summaryRawResponses).toEqual([rawResponse]);
  });

  test("does not parse user-authored summary marker text as internal summary", () => {
    const userMessage: Message = {
      role: "user",
      content: [
        {
          type: "text",
          text: `${CONTEXT_SUMMARY_MARKER}\nI typed this prefix myself`,
        },
      ],
    };
    expect(getSummaryFromContextMessage(userMessage)).toBeNull();
  });

  test("skips compaction during cooldown", async () => {
    const provider = createProvider(() => {
      throw new Error(
        "summarizer should not be called while cooldown skip is active",
      );
    });
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config: makeConfig({
        maxInputTokens: 260,
        targetBudgetRatio: 0.74,
      }),
    });
    const long = "c".repeat(220);
    const history: Message[] = [
      message("user", `u1 ${long}`),
      message("assistant", `a1 ${long}`),
      message("user", `u2 ${long}`),
    ];

    const result = await manager.maybeCompact(history, undefined, {
      lastCompactedAt: Date.now() - 30_000,
    });
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("compaction cooldown active");
  });

  test("ignores cooldown and compacts under severe token pressure", async () => {
    const provider = createProvider(() => ({
      content: [{ type: "text", text: "## Goals\n- compacted under pressure" }],
      model: "mock-model",
      usage: { inputTokens: 60, outputTokens: 12 },
      stopReason: "end_turn",
    }));
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config: makeConfig({
        maxInputTokens: 320,
        targetBudgetRatio: 0.61,
      }),
    });
    const long = "p".repeat(340);
    const history: Message[] = [
      message("user", `u1 ${long}`),
      message("assistant", `a1 ${long}`),
      message("user", `u2 ${long}`),
      message("assistant", `a2 ${long}`),
      message("user", `u3 ${long}`),
    ];

    const result = await manager.maybeCompact(history, undefined, {
      lastCompactedAt: Date.now() - 30_000,
    });
    expect(result.compacted).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test("force=true bypasses cooldown for context-too-large recovery", async () => {
    const provider = createProvider(() => ({
      content: [{ type: "text", text: "## Goals\n- forced compaction" }],
      model: "mock-model",
      usage: { inputTokens: 60, outputTokens: 12 },
      stopReason: "end_turn",
    }));
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config: makeConfig({
        maxInputTokens: 260,
        targetBudgetRatio: 0.74,
      }),
    });
    const long = "c".repeat(220);
    const history: Message[] = [
      message("user", `u1 ${long}`),
      message("assistant", `a1 ${long}`),
      message("user", `u2 ${long}`),
    ];

    // Same setup as the cooldown test, but with force=true — should compact.
    const result = await manager.maybeCompact(history, undefined, {
      lastCompactedAt: Date.now() - 30_000,
      force: true,
    });
    expect(result.compacted).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test("image-heavy payload is no longer underestimated as below-threshold", async () => {
    const provider = createProvider(() => ({
      content: [
        { type: "text", text: "## Goals\n- compacted image-heavy history" },
      ],
      model: "mock-model",
      usage: { inputTokens: 75, outputTokens: 20 },
      stopReason: "end_turn",
    }));
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config: makeConfig({
        maxInputTokens: 7000,
        targetBudgetRatio: 0.76,
        compactThreshold: 0.8,
      }),
    });

    const images = Array.from({ length: 5 }, (_, i) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: "image/png",
        data: `${String(i)}${"A".repeat(40_000)}`,
      },
    }));

    const history: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Please analyze these screenshots." },
          ...images,
        ],
      },
      message("assistant", "Sure, uploading now."),
    ];

    const result = await manager.maybeCompact(history);
    expect(result.reason).not.toBe("below compaction threshold");

    // Sanity check for this repro: counting raw base64 as text would exceed threshold.
    const rawBase64Chars = images.reduce(
      (sum, img) => sum + img.source.data.length,
      0,
    );
    const rawBase64TokenEquivalent = estimateTextTokens(
      "A".repeat(rawBase64Chars),
    );
    expect(rawBase64TokenEquivalent).toBeGreaterThan(result.thresholdTokens);
  });

  test("force=true without override uses configured target and summarizes", async () => {
    // Regression for the "compaction no-op" bug: when mid-loop / forced
    // compaction passed `targetInputTokensOverride: preflightBudget`
    // (~170k on a 200k window), pickKeepBoundary would say "all turns
    // already fit, keep everything" and the compactor would take the
    // truncate-only early-exit branch, returning compacted:true with
    // compactedPersistedMessages:0 — a silent no-op that let context
    // balloon past the provider cap.
    //
    // This test asserts that with `force: true` and NO override, the
    // manager falls back to its configured `targetInputTokens` and
    // actually summarizes older turns.
    const provider = createProvider(() => ({
      content: [{ type: "text", text: "## Goals\n- real summary" }],
      model: "mock-model",
      usage: { inputTokens: 80, outputTokens: 20 },
      stopReason: "end_turn",
    }));
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      // targetBudgetRatio - summaryBudgetRatio = 0.25, so targetInputTokens
      // is 25% of maxInputTokens — tight enough to force summarization.
      config: makeConfig({
        maxInputTokens: 600,
        targetBudgetRatio: 0.3,
        summaryBudgetRatio: 0.05,
        compactThreshold: 0.6,
      }),
    });
    const long = "x".repeat(80);
    const history: Message[] = [
      message("user", `u1 ${long}`),
      message("assistant", `a1 ${long}`),
      message("user", `u2 ${long}`),
      message("assistant", `a2 ${long}`),
      message("user", `u3 ${long}`),
      message("assistant", `a3 ${long}`),
      message("user", `u4 ${long}`),
    ];

    const result = await manager.maybeCompact(history, undefined, {
      force: true,
    });

    expect(result.compacted).toBe(true);
    // The key assertion: persisted messages must be summarized, not just
    // tool-result-truncated. compactedPersistedMessages > 0 means we
    // actually did work rather than taking the no-op early-exit.
    expect(result.compactedPersistedMessages).toBeGreaterThan(0);
    expect(result.summaryCalls).toBe(1);
  });

  test("minKeepRecentUserTurns: 0 compacts all messages into summary only", async () => {
    const provider = createProvider(() => ({
      content: [{ type: "text", text: "## Goals\n- emergency summary" }],
      model: "mock-model",
      usage: { inputTokens: 60, outputTokens: 12 },
      stopReason: "end_turn",
    }));
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config: makeConfig({
        maxInputTokens: 260,
        targetBudgetRatio: 0.28,
      }),
    });
    const long = "e".repeat(220);
    const history: Message[] = [
      message("user", `u1 ${long}`),
      message("assistant", `a1 ${long}`),
      message("user", `u2 ${long}`),
    ];

    const result = await manager.maybeCompact(history, undefined, {
      force: true,
      minKeepRecentUserTurns: 0,
    });
    expect(result.compacted).toBe(true);
    // With minKeepRecentUserTurns=0 and a tight target budget,
    // pickKeepBoundary drops keepTurns all the way to 0.
    // All three messages are compacted into a single summary message.
    expect(result.compactedMessages).toBe(3);
    expect(result.messages).toHaveLength(1);
    expect(getSummaryFromContextMessage(result.messages[0])).toContain(
      "emergency summary",
    );
  });

  test("shouldCompact returns needed=false with estimatedTokens when below threshold", () => {
    const provider = createProvider(() => {
      throw new Error("should not be called");
    });
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config: makeConfig(),
    });
    const history = [message("user", "hello"), message("assistant", "hi")];
    const result = manager.shouldCompact(history);
    expect(result.needed).toBe(false);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  test("shouldCompact returns needed=true with estimatedTokens when above threshold", () => {
    const provider = createProvider(() => {
      throw new Error("should not be called");
    });
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config: makeConfig(),
    });
    const long = "x".repeat(240);
    const history: Message[] = [
      message("user", `u1 ${long}`),
      message("assistant", `a1 ${long}`),
      message("user", `u2 ${long}`),
      message("assistant", `a2 ${long}`),
      message("user", `u3 ${long}`),
      message("assistant", `a3 ${long}`),
    ];
    const result = manager.shouldCompact(history);
    expect(result.needed).toBe(true);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  test("shouldCompact returns needed=false with zero estimatedTokens when disabled", () => {
    const provider = createProvider(() => {
      throw new Error("should not be called");
    });
    const long = "x".repeat(240);
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config: makeConfig({ enabled: false }),
    });
    const history: Message[] = [
      message("user", `u1 ${long}`),
      message("assistant", `a1 ${long}`),
      message("user", `u2 ${long}`),
      message("assistant", `a2 ${long}`),
    ];
    const result = manager.shouldCompact(history);
    expect(result.needed).toBe(false);
    expect(result.estimatedTokens).toBe(0);
  });

  test("truncates tool results in kept turns to preserve more conversation", async () => {
    const provider = createProvider(() => ({
      content: [{ type: "text", text: "## Goals\n- truncation summary" }],
      model: "mock-model",
      usage: { inputTokens: 60, outputTokens: 12 },
      stopReason: "end_turn",
    }));
    // Budget is tight enough that full 8K tool results would force dropping turns,
    // but truncated results (≤6K chars) should allow more turns to be kept.
    const config = makeConfig({
      maxInputTokens: 4000,
      targetBudgetRatio: 0.7,
    });
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config,
    });

    const largeToolResult = "x".repeat(8000);
    const history: Message[] = [
      message("user", "u1"),
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "read_file",
            input: { path: "/tmp/a" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: largeToolResult,
          },
        ],
      },
      message("assistant", "a1"),
      message("user", "u2"),
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: "read_file",
            input: { path: "/tmp/b" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t2",
            content: largeToolResult,
          },
        ],
      },
      message("assistant", "a2"),
      message("user", "u3"),
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t3",
            name: "read_file",
            input: { path: "/tmp/c" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t3",
            content: largeToolResult,
          },
        ],
      },
      message("assistant", "a3"),
      message("user", "u4"),
      message("assistant", "a4"),
    ];

    const result = await manager.maybeCompact(history, undefined, {
      force: true,
    });
    expect(result.compacted).toBe(true);

    // Verify tool results in output are truncated (should be < 8K chars each).
    for (const msg of result.messages) {
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          expect(block.content.length).toBeLessThan(8000);
        }
      }
    }
  });

  test("targetInputTokensOverride reduces retained turns beyond normal compaction", async () => {
    const provider = createProvider(() => ({
      content: [{ type: "text", text: "## Goals\n- tight fit summary" }],
      model: "mock-model",
      usage: { inputTokens: 60, outputTokens: 12 },
      stopReason: "end_turn",
    }));

    // Use generous default target so normal compaction would keep all 3 user turns.
    const config = makeConfig({
      maxInputTokens: 1200,
      targetBudgetRatio: 0.88,
    });
    const long = "t".repeat(220);
    const history: Message[] = [
      message("user", `u1 ${long}`),
      message("assistant", `a1 ${long}`),
      message("user", `u2 ${long}`),
      message("assistant", `a2 ${long}`),
      message("user", `u3 ${long}`),
      message("assistant", `a3 ${long}`),
    ];

    // Without override: normal compaction keeps more turns.
    const normalManager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config,
    });
    const normalResult = await normalManager.maybeCompact(history, undefined, {
      force: true,
    });

    // With a very tight override target: should keep fewer turns.
    const tightManager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config,
    });
    const tightResult = await tightManager.maybeCompact(history, undefined, {
      force: true,
      targetInputTokensOverride: 80,
    });

    expect(tightResult.compacted).toBe(true);
    // The tight override should compact more messages than normal.
    expect(tightResult.compactedMessages).toBeGreaterThan(
      normalResult.compactedMessages,
    );
  });

  test("subtracts summaryOffset only when summary at index 0 was injected from parent", async () => {
    const provider = createProvider(() => ({
      content: [{ type: "text", text: "## Goals\n- new child summary" }],
      model: "mock-model",
      usage: { inputTokens: 75, outputTokens: 20 },
      stopReason: "end_turn",
    }));
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config: makeConfig({
        maxInputTokens: 320,
        targetBudgetRatio: 0.58,
      }),
    });
    const long = "k".repeat(220);
    // Parent-injected summary at index 0, plus 2 injected non-persisted
    // messages, plus 3 child-persisted messages. nonPersistedPrefixCount
    // includes the summary (set by injectInheritedContext).
    const history: Message[] = [
      createContextSummaryMessage("parent summary"),
      message("user", `injected-u ${long}`),
      message("assistant", `injected-a ${long}`),
      message("user", `persisted-u1 ${long}`),
      message("assistant", `persisted-a1 ${long}`),
      message("user", `persisted-u2 ${long}`),
    ];
    manager.nonPersistedPrefixCount = 3;
    manager.summaryIsInjected = true;

    const result = await manager.maybeCompact(history, undefined, {
      force: true,
    });
    expect(result.compacted).toBe(true);
    // 4 messages compacted (2 injected + 2 child-persisted), but only the
    // 2 child-persisted ones count as DB-persisted.
    expect(result.compactedMessages).toBe(4);
    expect(result.compactedPersistedMessages).toBe(2);
    // Flag clears and prefix drains (both injected messages + summary slot).
    expect(manager.summaryIsInjected).toBe(false);
    expect(manager.nonPersistedPrefixCount).toBe(0);
  });

  test("does not subtract summaryOffset when summary at index 0 is child-owned from prior compaction", async () => {
    const provider = createProvider(() => ({
      content: [{ type: "text", text: "## Goals\n- next child summary" }],
      model: "mock-model",
      usage: { inputTokens: 75, outputTokens: 20 },
      stopReason: "end_turn",
    }));
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config: makeConfig({
        maxInputTokens: 320,
        targetBudgetRatio: 0.58,
      }),
    });
    const long = "k".repeat(220);
    // Post-first-compaction state: child-owned summary at index 0, 2
    // still-injected messages that survived the first compaction's keep
    // region, 3 child-persisted messages. nonPersistedPrefixCount reflects
    // only the 2 remaining injected messages — the summary slot was already
    // consumed when the flag-gated decrement ran on the prior compaction.
    const history: Message[] = [
      createContextSummaryMessage("prior child summary"),
      message("user", `injected-u ${long}`),
      message("assistant", `injected-a ${long}`),
      message("user", `persisted-u1 ${long}`),
      message("assistant", `persisted-a1 ${long}`),
      message("user", `persisted-u2 ${long}`),
    ];
    manager.nonPersistedPrefixCount = 2;
    manager.summaryIsInjected = false;

    const result = await manager.maybeCompact(history, undefined, {
      force: true,
    });
    expect(result.compacted).toBe(true);
    expect(result.compactedMessages).toBe(4);
    // Regression guard: without the flag gate, the subtraction from the
    // #24353 fix would double-apply here (nonPersistedPrefixCount - 1),
    // undercounting injectedInCompactable and inflating
    // compactedPersistedMessages by 1 (to 3).
    expect(result.compactedPersistedMessages).toBe(2);
    expect(manager.nonPersistedPrefixCount).toBe(0);
  });
});
