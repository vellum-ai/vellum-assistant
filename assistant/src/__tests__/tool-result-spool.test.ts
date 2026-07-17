import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { AgentEvent } from "../agent/loop.js";
import { AgentLoop } from "../agent/loop.js";
import {
  getToolResultFilePath,
  postTurnTruncateToolResults,
  THRESHOLD_CHARS,
  TOOL_RESULT_DIR,
  TRUNCATION_MARKER,
} from "../context/post-turn-tool-result-truncation.js";
import { spoolAndStubOversizedToolResults } from "../context/tool-result-spool.js";
import { resetPluginRegistryAndRegisterDefaults } from "../plugins/defaults/index.js";
import type {
  ContentBlock,
  Message,
  ToolDefinition,
} from "../providers/types.js";
import {
  createMockProvider,
  textResponse,
  toolUseResponse,
} from "./helpers/mock-provider.js";

function makeToolResult(
  content: string,
  toolUseId = "tool_use_1",
  is_error = false,
): ContentBlock {
  return {
    type: "tool_result" as const,
    tool_use_id: toolUseId,
    content,
    ...(is_error ? { is_error: true } : {}),
  };
}

const LONG = "x".repeat(THRESHOLD_CHARS + 100);
const SHORT = "y".repeat(100);

describe("spoolAndStubOversizedToolResults", () => {
  let convDir: string;
  const noName = () => undefined;

  beforeEach(() => {
    convDir = mkdtempSync(join(tmpdir(), "tool-result-spool-"));
  });

  afterEach(() => {
    rmSync(convDir, { recursive: true, force: true });
  });

  test("spools an oversized result and swaps in the stub", () => {
    const blocks = [makeToolResult(LONG, "tu_big")];

    const count = spoolAndStubOversizedToolResults(blocks, {
      conversationDir: convDir,
      toolNameById: noName,
    });

    expect(count).toBe(1);
    const filePath = getToolResultFilePath(convDir, "tu_big");
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe(LONG);
    const stubbed = blocks[0] as { content: string };
    expect(stubbed.content).toContain(TRUNCATION_MARKER);
    expect(stubbed.content).toContain(filePath);
    expect(stubbed.content.length).toBeLessThan(LONG.length);
  });

  test("stub is byte-identical to the post-turn truncation stub", () => {
    const blocks = [makeToolResult(LONG, "tu_big")];
    spoolAndStubOversizedToolResults(blocks, {
      conversationDir: convDir,
      toolNameById: noName,
    });

    const { messages: postTurn } = postTurnTruncateToolResults(
      [{ role: "user", content: [makeToolResult(LONG, "tu_big")] }],
      { conversationDir: convDir },
    );

    expect((blocks[0] as { content: string }).content).toBe(
      (postTurn[0].content[0] as { content: string }).content,
    );
  });

  test("post-turn pass is a no-op on result-time stubs", () => {
    const blocks = [makeToolResult(LONG, "tu_big")];
    spoolAndStubOversizedToolResults(blocks, {
      conversationDir: convDir,
      toolNameById: noName,
    });

    const history: Message[] = [{ role: "user", content: [...blocks] }];
    const { messages, truncatedCount } = postTurnTruncateToolResults(history, {
      conversationDir: convDir,
    });

    expect(truncatedCount).toBe(0);
    expect(messages).toBe(history);
  });

  test("skips below-threshold, error, exempt, file_read, host_file_read, web_fetch, marked, and ax-tree results", () => {
    const blocks = [
      makeToolResult(SHORT, "tu_short"),
      makeToolResult(LONG, "tu_err", true),
      makeToolResult(LONG, "tu_skill"),
      makeToolResult(LONG, "tu_read"),
      makeToolResult(LONG, "tu_host_read"),
      makeToolResult(LONG, "tu_web_fetch"),
      makeToolResult(`${LONG}${TRUNCATION_MARKER}`, "tu_marked"),
      makeToolResult(`<ax-tree>${LONG}</ax-tree>`, "tu_ax"),
      { type: "text" as const, text: LONG },
    ];
    const originals = blocks.map((b) => b);

    const count = spoolAndStubOversizedToolResults(blocks, {
      conversationDir: convDir,
      toolNameById: (id) => {
        if (id === "tu_skill") {
          return "skill_load";
        }
        if (id === "tu_read") {
          return "file_read";
        }
        if (id === "tu_host_read") {
          return "host_file_read";
        }
        if (id === "tu_web_fetch") {
          return "web_fetch";
        }
        return undefined;
      },
    });

    expect(count).toBe(0);
    expect(blocks).toEqual(originals);
    expect(existsSync(join(convDir, TOOL_RESULT_DIR))).toBe(false);
  });

  test("spools each eligible block in a mixed batch", () => {
    const blocks = [
      makeToolResult(LONG, "tu_a"),
      makeToolResult(SHORT, "tu_b"),
      makeToolResult(LONG, "tu_c"),
    ];

    const count = spoolAndStubOversizedToolResults(blocks, {
      conversationDir: convDir,
      toolNameById: noName,
    });

    expect(count).toBe(2);
    expect(existsSync(getToolResultFilePath(convDir, "tu_a"))).toBe(true);
    expect(existsSync(getToolResultFilePath(convDir, "tu_b"))).toBe(false);
    expect(existsSync(getToolResultFilePath(convDir, "tu_c"))).toBe(true);
    expect((blocks[0] as { content: string }).content).toContain(
      TRUNCATION_MARKER,
    );
    expect((blocks[1] as { content: string }).content).toBe(SHORT);
    expect((blocks[2] as { content: string }).content).toContain(
      TRUNCATION_MARKER,
    );
  });

  test("keeps full content when the spool directory cannot be created", () => {
    // A regular file at the conversation-dir path makes mkdir throw, so no
    // stub can be written; the block must keep its full content (a stub must
    // never exist without its file on disk).
    const fileAsDir = join(convDir, "not-a-dir");
    writeFileSync(fileAsDir, "occupied", "utf-8");
    const blocks = [makeToolResult(LONG, "tu_big")];

    expect(() =>
      spoolAndStubOversizedToolResults(blocks, {
        conversationDir: fileAsDir,
        toolNameById: noName,
      }),
    ).toThrow();
    expect((blocks[0] as { content: string }).content).toBe(LONG);
  });
});

describe("AgentLoop result-time spooling", () => {
  let convDir: string;

  const dummyTools: ToolDefinition[] = [
    {
      name: "fetch_transcript",
      description: "Fetch a transcript",
      input_schema: { type: "object", properties: {} },
    },
  ];

  const userMessage: Message = {
    role: "user",
    content: [{ type: "text", text: "Import the transcripts" }],
  };

  beforeEach(() => {
    resetPluginRegistryAndRegisterDefaults();
    convDir = mkdtempSync(join(tmpdir(), "tool-result-spool-loop-"));
  });

  afterEach(() => {
    rmSync(convDir, { recursive: true, force: true });
  });

  test("oversized result enters history as the stub; full content is never sent to the provider", async () => {
    const { provider, calls } = createMockProvider([
      toolUseResponse("tu_1", "fetch_transcript", {}),
      textResponse("Done."),
    ]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: async () => ({ content: LONG, isError: false }),
      resolveConversationDir: () => convDir,
    });

    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: (e) => {
        events.push(e);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    const filePath = getToolResultFilePath(convDir, "tu_1");
    expect(readFileSync(filePath, "utf-8")).toBe(LONG);

    // The second provider call carries the stub, not the full content.
    const sentResult = calls[1].messages[2].content[0] as { content: string };
    expect(sentResult.content).toContain(TRUNCATION_MARKER);
    expect(sentResult.content).toContain(filePath);
    expect(JSON.stringify(calls.map((c) => c.messages))).not.toContain(LONG);

    // Durable history and the emitted tool_result event match what was sent.
    const historyResult = history[2].content[0] as { content: string };
    expect(historyResult.content).toBe(sentResult.content);
    const resultEvent = events.find((e) => e.type === "tool_result") as {
      content: string;
    };
    expect(resultEvent.content).toBe(sentResult.content);
  });

  test("outbound payloads stay append-only across calls (prompt-cache prefix invariant)", async () => {
    const { provider, calls } = createMockProvider([
      toolUseResponse("tu_1", "fetch_transcript", {}),
      toolUseResponse("tu_2", "fetch_transcript", {}),
      textResponse("Done."),
    ]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: async () => ({ content: LONG, isError: false }),
      resolveConversationDir: () => convDir,
    });

    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    expect(calls).toHaveLength(3);
    // Each call's payload extends the previous call's payload without
    // rewriting it — the property that keeps the provider's prompt-cache
    // prefix valid across the turn's iterations.
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i].messages.slice(0, calls[i - 1].messages.length)).toEqual(
        calls[i - 1].messages,
      );
    }
  });

  test("spools the raw output even when it exceeds the post-tool-use truncation budget", async () => {
    // maxInputTokens of 10k gives the default truncate plugin a 12k-char
    // budget (0.3 share × 4 chars/token). The spool must run before that
    // hook, so the file holds all 20k chars of raw output rather than the
    // hook's tail-dropped copy — otherwise the omitted tail is unrecoverable.
    const HUGE = "z".repeat(20_000);
    const { provider } = createMockProvider([
      toolUseResponse("tu_1", "fetch_transcript", {}),
      textResponse("Done."),
    ]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      config: { maxInputTokens: 10_000 },
      tools: dummyTools,
      toolExecutor: async () => ({ content: HUGE, isError: false }),
      resolveConversationDir: () => convDir,
    });

    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    const filePath = getToolResultFilePath(convDir, "tu_1");
    expect(readFileSync(filePath, "utf-8")).toBe(HUGE);
  });

  test("web_fetch result is sent to the provider in full mid-turn (explicit self-sized read)", async () => {
    const webFetchTool: ToolDefinition[] = [
      {
        name: "web_fetch",
        description: "Fetch a web page",
        input_schema: { type: "object", properties: {} },
      },
    ];
    const { provider, calls } = createMockProvider([
      toolUseResponse("tu_wf", "web_fetch", {}),
      textResponse("Done."),
    ]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: webFetchTool,
      toolExecutor: async () => ({ content: LONG, isError: false }),
      resolveConversationDir: () => convDir,
    });

    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // The second provider call carries the full requested window, not a stub;
    // the post-turn pass (conversation-turn-finalize) owns truncating it.
    const sentResult = calls[1].messages[2].content[0] as { content: string };
    expect(sentResult.content).toBe(LONG);
    expect(existsSync(join(convDir, TOOL_RESULT_DIR))).toBe(false);
  });

  test("without resolveConversationDir the full content is sent and post-turn handles it", async () => {
    const { provider, calls } = createMockProvider([
      toolUseResponse("tu_1", "fetch_transcript", {}),
      textResponse("Done."),
    ]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: dummyTools,
      toolExecutor: async () => ({ content: LONG, isError: false }),
    });

    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    const sentResult = calls[1].messages[2].content[0] as { content: string };
    expect(sentResult.content).toBe(LONG);
    expect(existsSync(join(convDir, TOOL_RESULT_DIR))).toBe(false);
  });
});
