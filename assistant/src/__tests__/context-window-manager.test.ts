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
  ContentBlock,
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
  name: string = "mock",
): Provider {
  return {
    name,
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

  test("marks summaryFailed when the provider throws and fallback runs", async () => {
    // The agent-loop circuit breaker distinguishes "LLM call failed but
    // fallback rescued us" from "compaction succeeded end-to-end". The
    // fallback path must set summaryFailed:true so callers can count
    // consecutive failures without losing the compacted messages.
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
    expect(result.summaryFailed).toBe(true);
  });

  test("does not mark summaryFailed on a successful provider call", async () => {
    const provider = createProvider(() => ({
      content: [
        { type: "text", text: "## Goals\n- summary produced by provider" },
      ],
      model: "mock-model",
      usage: { inputTokens: 60, outputTokens: 12 },
      stopReason: "end_turn",
    }));
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
    expect(result.summaryFailed).toBe(false);
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
        maxInputTokens: 620,
        targetBudgetRatio: 0.59,
        compactThreshold: 0.5,
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

  test.todo(
    "force compaction with loose target override still summarizes persisted messages",
    async () => {
      // Regression test for a mid-loop compaction no-op observed in a
      // user feedback report: a long conversation reached ~247k tokens
      // against a 200k budget with the UI spinning on "compacting"
      // while compaction ran repeatedly and summarized nothing.
      //
      // Root cause (window-manager.ts:278-312 truncate-only early-exit):
      // mid-loop compaction invokes maybeCompact with
      //   { force: true, targetInputTokensOverride: preflightBudget }
      // where preflightBudget ≈ maxInputTokens * 0.85. When the current
      // history estimate is BELOW the override, pickKeepBoundary's
      // projected-fit check finds "all turns already fit" and takes the
      // early-exit branch that truncates tool results without running a
      // summary call. Result: `compacted: true` but
      // `compactedPersistedMessages: 0` — a silent no-op.
      //
      // Expected behavior (once compaction logic is cleaned up): a
      // forced compaction that fires above the compact threshold must
      // actually summarize persisted messages, regardless of whether a
      // loose override was passed.

      let summaryCalls = 0;
      const provider = createProvider(() => {
        summaryCalls += 1;
        return {
          content: [{ type: "text", text: "## Goals\n- real summary" }],
          model: "mock-model",
          usage: { inputTokens: 80, outputTokens: 20 },
          stopReason: "end_turn",
        };
      });

      // Scaled mirror of production config (200k → 1000):
      //   maxInputTokens       = 1000 (prod 200k)
      //   compactThreshold     = 0.3  → threshold 300   (prod 160k)
      //   targetBudgetRatio    = 0.1  → post-compact target 50 (prod 50k)
      //   summaryBudgetRatio   = 0.05
      //
      // Production uses maxInputTokens=200_000, compactThreshold=0.8,
      // targetBudgetRatio=0.3, summaryBudgetRatio=0.05. We shrink the
      // absolute numbers to keep the test fast while preserving the key
      // ratio: the mid-loop override (~0.85 × max) is roughly 17× the
      // post-compaction target (~0.05 × max), so any history that sits
      // between "above threshold" and "below override" hits the bug.
      const manager = new ContextWindowManager({
        provider,
        systemPrompt: "system prompt",
        config: makeConfig({
          maxInputTokens: 1000,
          targetBudgetRatio: 0.1,
          summaryBudgetRatio: 0.05,
          compactThreshold: 0.3,
        }),
      });

      // Build a history sized in the "no-op zone": well above the
      // 300-token compact threshold, well below the 850-token preflight
      // budget analog.
      const long = "x".repeat(180);
      const history: Message[] = [
        message("user", `u1 ${long}`),
        message("assistant", `a1 ${long}`),
        message("user", `u2 ${long}`),
        message("assistant", `a2 ${long}`),
        message("user", `u3 ${long}`),
        message("assistant", `a3 ${long}`),
        message("user", `u4 ${long}`),
        message("assistant", `a4 ${long}`),
        message("user", `u5 ${long}`),
      ];

      // Simulate the mid-loop caller pattern: force + override set to
      // preflightBudget (maxInputTokens * 0.85 = 850).
      const preflightBudgetAnalog = Math.floor(1000 * 0.85);
      const result = await manager.maybeCompact(history, undefined, {
        force: true,
        targetInputTokensOverride: preflightBudgetAnalog,
      });

      // The reported token count (to prove we were actually in the
      // "should compact" zone).
      expect(result.previousEstimatedInputTokens).toBeGreaterThan(
        result.thresholdTokens,
      );

      // ── Expected post-fix behavior ───────────────────────────────
      // At least one real summarization happened. (Under the current
      // buggy code path this fails — `compactedPersistedMessages` is 0
      // and `summaryCalls` is 0 because pickKeepBoundary short-circuits
      // into the truncate-only early-exit.)
      expect(result.compactedPersistedMessages).toBeGreaterThan(0);
      expect(summaryCalls).toBeGreaterThan(0);
    },
  );

  test("force=true compacts below minFloor when a kept turn exceeds target", async () => {
    // A giant paste in the last user turn means minFloor=1 alone exceeds target.
    // Under force, pickKeepBoundary should walk keepTurns below minFloor (down to
    // 0) so the huge block falls into the compacted region and gets summarized
    // instead of being kept at full size.
    const provider = createProvider(() => ({
      content: [{ type: "text", text: "## Goals\n- compressed large paste" }],
      model: "mock-model",
      usage: { inputTokens: 120, outputTokens: 20 },
      stopReason: "end_turn",
    }));
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config: makeConfig({ maxInputTokens: 600, targetBudgetRatio: 0.2 }),
    });
    const hugePaste = "p".repeat(4000); // ~1000 tokens, well above targetInputTokens
    const history: Message[] = [
      message("user", "u1 small"),
      message("assistant", "a1 small"),
      message("user", `u2 ${hugePaste}`),
    ];

    const result = await manager.maybeCompact(history, undefined, {
      force: true,
    });

    expect(result.compacted).toBe(true);
    // With force=true the kept region is empty; all turns including the oversized
    // paste were summarized, so the compacted result is just the summary.
    expect(result.messages).toHaveLength(1);
    expect(result.compactedMessages).toBe(history.length);
    expect(getSummaryFromContextMessage(result.messages[0])).toContain(
      "compressed large paste",
    );
    expect(result.estimatedInputTokens).toBeLessThan(
      result.previousEstimatedInputTokens,
    );
  });

  test("force=false honors minFloor even when the kept turn exceeds target", async () => {
    // Same oversized paste, but without force the algorithm must preserve the
    // minFloor=1 recent turn (auto mid-loop compaction needs the in-flight turn
    // intact). Anything compactable before the floor still gets summarized.
    const provider = createProvider(() => ({
      content: [{ type: "text", text: "## Goals\n- summary" }],
      model: "mock-model",
      usage: { inputTokens: 60, outputTokens: 10 },
      stopReason: "end_turn",
    }));
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config: makeConfig({ maxInputTokens: 600, targetBudgetRatio: 0.2 }),
    });
    const hugePaste = "p".repeat(4000);
    const history: Message[] = [
      message("user", "u1 small"),
      message("assistant", "a1 small"),
      message("user", "u2 small"),
      message("assistant", "a2 small"),
      message("user", `u3 ${hugePaste}`),
    ];

    const result = await manager.maybeCompact(history);

    expect(result.compacted).toBe(true);
    // The oversized last user turn is retained verbatim; the kept array starts
    // with the summary followed by the messages from that turn onward.
    const lastUser = result.messages
      .filter((m) => m.role === "user")
      .map((m) => (m.content[0].type === "text" ? m.content[0].text : ""))
      .find((t) => t.startsWith("u3 "));
    expect(lastUser).toBeDefined();
    expect(lastUser!.length).toBeGreaterThan(hugePaste.length);
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

  test("summary system prompt instructs verbatim thread-anchor preservation", async () => {
    const capturedSystemPrompts: (string | undefined)[] = [];
    const provider: Provider = {
      name: "mock",
      async sendMessage(
        _messages: Message[],
        _tools,
        systemPrompt,
      ): Promise<ProviderResponse> {
        capturedSystemPrompts.push(systemPrompt);
        return {
          content: [
            {
              type: "text",
              text: "## Goals\n- preserved thread parent verbatim",
            },
          ],
          model: "mock-model",
          usage: { inputTokens: 60, outputTokens: 12 },
          stopReason: "end_turn",
        };
      },
    };
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config: makeConfig({ maxInputTokens: 600 }),
    });
    const long = "x".repeat(240);
    // Simulate a Slack-style transcript where an old user "thread parent"
    // message is about to be compacted while a later reply survives in the
    // retained tail. The clause being asserted instructs the summarizer to
    // preserve that parent verbatim — we cannot verify the model's behavior
    // here (the provider is a stub), so we instead assert the clause itself
    // reaches the summarizer.
    const history: Message[] = [
      message("user", `parent: kickoff plan ${long}`),
      message("assistant", `a1 ${long}`),
      message("user", `u2 ${long}`),
      message("assistant", `a2 ${long}`),
      message("user", `reply-in-thread ${long}`),
      message("assistant", `a3 ${long}`),
    ];

    const result = await manager.maybeCompact(history);
    expect(result.compacted).toBe(true);
    expect(capturedSystemPrompts.length).toBeGreaterThan(0);
    const seenPrompt = capturedSystemPrompts[0];
    expect(seenPrompt).toBeDefined();
    expect(seenPrompt).toContain("Thread anchors");
    expect(seenPrompt).toContain("verbatim");
  });

  test("summary prompt lists retained-tail thread-reply references", async () => {
    const capturedMessages: Message[][] = [];
    const provider: Provider = {
      name: "mock",
      async sendMessage(messages: Message[]): Promise<ProviderResponse> {
        capturedMessages.push(messages);
        return {
          content: [{ type: "text", text: "## Goals\n- ok" }],
          model: "mock-model",
          usage: { inputTokens: 60, outputTokens: 12 },
          stopReason: "end_turn",
        };
      },
    };
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config: makeConfig({ maxInputTokens: 600 }),
    });
    const long = "x".repeat(240);
    // Compactable region ends before the retained tail, which contains a
    // Slack-style reply line that cites its parent via `→ M1a2b3c`. The
    // summary prompt must surface that reference so the Thread-anchors
    // instruction has something to act on.
    const history: Message[] = [
      message("user", `[11/14/23 14:25 @alice]: parent kickoff ${long}`),
      message("assistant", `a1 ${long}`),
      message("user", `u2 ${long}`),
      message("assistant", `a2 ${long}`),
      message("user", `[11/14/23 14:28 @bob → M1a2b3c]: reply ${long}`),
      message("assistant", `a3 ${long}`),
    ];

    const result = await manager.maybeCompact(history);
    expect(result.compacted).toBe(true);
    expect(capturedMessages.length).toBeGreaterThan(0);
    const userPromptText = capturedMessages[0]
      .flatMap((m) => m.content)
      .filter(
        (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
      )
      .map((b) => b.text)
      .join("\n");
    expect(userPromptText).toContain("### Retained Thread References");
    expect(userPromptText).toContain("→ M1a2b3c");
  });

  test("summary prompt lists retained-tail thread-reply references for edited replies", async () => {
    const capturedMessages: Message[][] = [];
    const provider: Provider = {
      name: "mock",
      async sendMessage(messages: Message[]): Promise<ProviderResponse> {
        capturedMessages.push(messages);
        return {
          content: [{ type: "text", text: "## Goals\n- ok" }],
          model: "mock-model",
          usage: { inputTokens: 60, outputTokens: 12 },
          stopReason: "end_turn",
        };
      },
    };
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config: makeConfig({ maxInputTokens: 600 }),
    });
    const long = "x".repeat(240);
    // An edited reply renders with `, edited …` between the parent alias and
    // the closing bracket: `→ Mxxxxxx, edited MM/DD/YY HH:MM]`. The regex
    // must still flag these lines so retention works for edited replies.
    const history: Message[] = [
      message("user", `[11/14/23 14:25 @alice]: parent kickoff ${long}`),
      message("assistant", `a1 ${long}`),
      message("user", `u2 ${long}`),
      message("assistant", `a2 ${long}`),
      message(
        "user",
        `[11/14/23 14:28 @bob → M1a2b3c, edited 11/14/23 14:32]: reply ${long}`,
      ),
      message("assistant", `a3 ${long}`),
    ];

    const result = await manager.maybeCompact(history);
    expect(result.compacted).toBe(true);
    expect(capturedMessages.length).toBeGreaterThan(0);
    const userPromptText = capturedMessages[0]
      .flatMap((m) => m.content)
      .filter(
        (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
      )
      .map((b) => b.text)
      .join("\n");
    expect(userPromptText).toContain("### Retained Thread References");
    expect(userPromptText).toContain("→ M1a2b3c, edited 11/14/23 14:32");
  });

  test("summary prompt omits retained references when retained tail has no thread markers", async () => {
    const capturedMessages: Message[][] = [];
    const provider: Provider = {
      name: "mock",
      async sendMessage(messages: Message[]): Promise<ProviderResponse> {
        capturedMessages.push(messages);
        return {
          content: [{ type: "text", text: "## Goals\n- ok" }],
          model: "mock-model",
          usage: { inputTokens: 60, outputTokens: 12 },
          stopReason: "end_turn",
        };
      },
    };
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
    const userPromptText = capturedMessages[0]
      .flatMap((m) => m.content)
      .filter(
        (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
      )
      .map((b) => b.text)
      .join("\n");
    expect(userPromptText).not.toContain("### Retained Thread References");
    expect(userPromptText).not.toMatch(/→ M[0-9a-f]{6}]/);
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

  test("Slack origin bumps default minKeepRecentUserTurns to 8", async () => {
    const provider = createProvider(() => ({
      content: [{ type: "text", text: "## Goals\n- slack thread context" }],
      model: "mock-model",
      usage: { inputTokens: 60, outputTokens: 12 },
      stopReason: "end_turn",
    }));

    // Use targetInputTokensOverride so the binary search is forced even
    // for a small history. Both managers see the same tight budget; the
    // only knob that varies is conversationOriginChannel.
    const config = makeConfig({ maxInputTokens: 12_000 });
    const long = "s".repeat(220);
    // 9 user turns: enough headroom for Slack's bumped floor of 8 to be
    // distinguishable from the default floor of 1.
    const history: Message[] = [];
    for (let i = 1; i <= 9; i++) {
      history.push(message("user", `u${i} ${long}`));
      history.push(message("assistant", `a${i} ${long}`));
    }

    const slackManager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config,
    });
    const slackResult = await slackManager.maybeCompact(history, undefined, {
      force: true,
      targetInputTokensOverride: 200,
      conversationOriginChannel: "slack",
    });

    const defaultManager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config,
    });
    const defaultResult = await defaultManager.maybeCompact(
      history,
      undefined,
      { force: true, targetInputTokensOverride: 200 },
    );

    expect(slackResult.compacted).toBe(true);
    expect(defaultResult.compacted).toBe(true);
    // Default floor (1 user turn) compacts more of the history than the
    // Slack floor (8 user turns), which preserves more recent context.
    expect(defaultResult.compactedMessages).toBeGreaterThan(
      slackResult.compactedMessages,
    );
    // Slack keeps 8 of 9 user turns: 16 kept messages, 2 compacted.
    expect(slackResult.compactedMessages).toBe(2);
  });

  test("non-Slack origin keeps default minKeepRecentUserTurns of 1", async () => {
    const provider = createProvider(() => ({
      content: [{ type: "text", text: "## Goals\n- standard summary" }],
      model: "mock-model",
      usage: { inputTokens: 60, outputTokens: 12 },
      stopReason: "end_turn",
    }));

    const config = makeConfig({ maxInputTokens: 12_000 });
    const long = "n".repeat(220);
    const history: Message[] = [];
    for (let i = 1; i <= 9; i++) {
      history.push(message("user", `u${i} ${long}`));
      history.push(message("assistant", `a${i} ${long}`));
    }

    // Telegram origin must behave identically to no-channel-hint default.
    const telegramManager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config,
    });
    const telegramResult = await telegramManager.maybeCompact(
      history,
      undefined,
      {
        force: true,
        targetInputTokensOverride: 200,
        conversationOriginChannel: "telegram",
      },
    );

    const defaultManager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config,
    });
    const defaultResult = await defaultManager.maybeCompact(
      history,
      undefined,
      { force: true, targetInputTokensOverride: 200 },
    );

    expect(telegramResult.compacted).toBe(true);
    expect(defaultResult.compacted).toBe(true);
    expect(telegramResult.compactedMessages).toBe(
      defaultResult.compactedMessages,
    );
  });

  test("explicit minKeepRecentUserTurns wins over Slack default", async () => {
    const provider = createProvider(() => ({
      content: [{ type: "text", text: "## Goals\n- emergency override" }],
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

    // Emergency override (`minKeepRecentUserTurns: 0`) must take precedence
    // over the Slack-bumped default of 8 — this guards the agent loop's
    // context-too-large recovery path which always passes 0.
    const result = await manager.maybeCompact(history, undefined, {
      force: true,
      minKeepRecentUserTurns: 0,
      conversationOriginChannel: "slack",
    });
    expect(result.compacted).toBe(true);
    expect(result.compactedMessages).toBe(3);
    expect(result.messages).toHaveLength(1);
  });
});
