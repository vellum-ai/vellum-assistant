import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  buildTruncatedContent,
  getToolResultFilePath,
  postTurnTruncateToolResults,
  THRESHOLD_CHARS,
  TOOL_RESULT_DIR,
  TRUNCATION_MARKER,
} from "../context/post-turn-tool-result-truncation.js";
import {
  spoolOversizedToolResults,
  stubStaleOversizedToolResults,
} from "../context/tool-result-spool.js";
import type { ContentBlock, Message } from "../providers/types.js";

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

function makeToolUseMessage(
  pairs: Array<{ id: string; name: string }>,
): Message {
  return {
    role: "assistant",
    content: pairs.map(({ id, name }) => ({
      type: "tool_use" as const,
      id,
      name,
      input: {},
    })),
  };
}

const LONG = "x".repeat(THRESHOLD_CHARS + 100);
const SHORT = "y".repeat(100);

describe("spoolOversizedToolResults", () => {
  let convDir: string;
  const noName = () => undefined;

  beforeEach(() => {
    convDir = mkdtempSync(join(tmpdir(), "tool-result-spool-"));
  });

  afterEach(() => {
    rmSync(convDir, { recursive: true, force: true });
  });

  test("writes oversized result to its deterministic path, content intact", () => {
    const blocks = [makeToolResult(LONG, "tu_big")];

    const count = spoolOversizedToolResults(blocks, {
      conversationDir: convDir,
      toolNameById: noName,
    });

    expect(count).toBe(1);
    const filePath = getToolResultFilePath(convDir, "tu_big");
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe(LONG);
    // The block itself is not modified.
    expect((blocks[0] as { content: string }).content).toBe(LONG);
  });

  test("skips below-threshold, error, exempt, marked, and ax-tree results", () => {
    const blocks = [
      makeToolResult(SHORT, "tu_short"),
      makeToolResult(LONG, "tu_err", true),
      makeToolResult(LONG, "tu_skill"),
      makeToolResult(`${LONG}${TRUNCATION_MARKER}`, "tu_marked"),
      makeToolResult(`<ax-tree>${LONG}</ax-tree>`, "tu_ax"),
      { type: "text" as const, text: LONG },
    ];

    const count = spoolOversizedToolResults(blocks, {
      conversationDir: convDir,
      toolNameById: (id) => (id === "tu_skill" ? "skill_load" : undefined),
    });

    expect(count).toBe(0);
    expect(existsSync(join(convDir, TOOL_RESULT_DIR))).toBe(false);
  });

  test("spools each eligible block in a mixed batch", () => {
    const blocks = [
      makeToolResult(LONG, "tu_a"),
      makeToolResult(SHORT, "tu_b"),
      makeToolResult(LONG, "tu_c"),
    ];

    const count = spoolOversizedToolResults(blocks, {
      conversationDir: convDir,
      toolNameById: noName,
    });

    expect(count).toBe(2);
    expect(existsSync(getToolResultFilePath(convDir, "tu_a"))).toBe(true);
    expect(existsSync(getToolResultFilePath(convDir, "tu_b"))).toBe(false);
    expect(existsSync(getToolResultFilePath(convDir, "tu_c"))).toBe(true);
  });
});

describe("stubStaleOversizedToolResults", () => {
  let convDir: string;

  beforeEach(() => {
    convDir = mkdtempSync(join(tmpdir(), "tool-result-stub-"));
  });

  afterEach(() => {
    rmSync(convDir, { recursive: true, force: true });
  });

  /** History with one stale tool-result message and one current one. */
  function staleAndCurrentHistory(staleBlock: ContentBlock): Message[] {
    return [
      makeToolUseMessage([{ id: "tu_stale", name: "some_tool" }]),
      { role: "user", content: [staleBlock] },
      makeToolUseMessage([{ id: "tu_current", name: "some_tool" }]),
      { role: "user", content: [makeToolResult(LONG, "tu_current")] },
    ];
  }

  function spoolFor(toolUseId: string, content: string): string {
    const count = spoolOversizedToolResults(
      [makeToolResult(content, toolUseId)],
      {
        conversationDir: convDir,
        toolNameById: () => undefined,
      },
    );
    expect(count).toBe(1);
    return getToolResultFilePath(convDir, toolUseId);
  }

  test("stubs a stale oversized result whose spooled file exists", () => {
    const filePath = spoolFor("tu_stale", LONG);
    const history = staleAndCurrentHistory(makeToolResult(LONG, "tu_stale"));

    const { messages, stubbedCount } = stubStaleOversizedToolResults(
      history,
      convDir,
    );

    expect(stubbedCount).toBe(1);
    const stale = messages[1].content[0] as { content: string };
    expect(stale.content).toContain(TRUNCATION_MARKER);
    expect(stale.content).toContain(filePath);
    expect(stale.content.length).toBeLessThan(LONG.length);
    // Input history is untouched (pure projection).
    expect((history[1].content[0] as { content: string }).content).toBe(LONG);
  });

  test("stub is byte-identical to the post-turn truncation stub", () => {
    spoolFor("tu_stale", LONG);
    const history = staleAndCurrentHistory(makeToolResult(LONG, "tu_stale"));

    const { messages } = stubStaleOversizedToolResults(history, convDir);
    const { messages: postTurn } = postTurnTruncateToolResults(
      [{ role: "user", content: [makeToolResult(LONG, "tu_stale")] }],
      { conversationDir: convDir },
    );

    expect((messages[1].content[0] as { content: string }).content).toBe(
      (postTurn[0].content[0] as { content: string }).content,
    );
  });

  test("keeps the most recent tool-result message intact", () => {
    spoolFor("tu_current", LONG);
    const history: Message[] = [
      makeToolUseMessage([{ id: "tu_current", name: "some_tool" }]),
      { role: "user", content: [makeToolResult(LONG, "tu_current")] },
    ];

    const { messages, stubbedCount } = stubStaleOversizedToolResults(
      history,
      convDir,
    );

    expect(stubbedCount).toBe(0);
    expect(messages).toBe(history);
  });

  test("leaves a stale result alone when its file is not on disk", () => {
    const history = staleAndCurrentHistory(makeToolResult(LONG, "tu_stale"));

    const { messages, stubbedCount } = stubStaleOversizedToolResults(
      history,
      convDir,
    );

    expect(stubbedCount).toBe(0);
    expect(messages).toBe(history);
  });

  test("skips error, exempt-tool, already-stubbed, and ax-tree results", () => {
    for (const [block, toolName] of [
      [makeToolResult(LONG, "tu_stale", true), "some_tool"],
      [makeToolResult(LONG, "tu_stale"), "skill_load"],
      [
        makeToolResult(
          buildTruncatedContent(
            LONG,
            getToolResultFilePath(convDir, "tu_stale"),
          ),
          "tu_stale",
        ),
        "some_tool",
      ],
      [makeToolResult(`<ax-tree>${LONG}</ax-tree>`, "tu_stale"), "some_tool"],
    ] as Array<[ContentBlock, string]>) {
      spoolFor("tu_stale", LONG);
      const history = [
        makeToolUseMessage([{ id: "tu_stale", name: toolName }]),
        { role: "user" as const, content: [block] },
        makeToolUseMessage([{ id: "tu_current", name: "some_tool" }]),
        {
          role: "user" as const,
          content: [makeToolResult(LONG, "tu_current")],
        },
      ];

      const { stubbedCount } = stubStaleOversizedToolResults(history, convDir);

      expect(stubbedCount).toBe(0);
    }
  });

  test("stubbing twice is a no-op the second time (idempotent)", () => {
    spoolFor("tu_stale", LONG);
    const history = staleAndCurrentHistory(makeToolResult(LONG, "tu_stale"));

    const first = stubStaleOversizedToolResults(history, convDir);
    const second = stubStaleOversizedToolResults(first.messages, convDir);

    expect(first.stubbedCount).toBe(1);
    expect(second.stubbedCount).toBe(0);
    expect(second.messages).toBe(first.messages);
  });

  test("history without tool results is returned unchanged", () => {
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];

    const { messages, stubbedCount } = stubStaleOversizedToolResults(
      history,
      convDir,
    );

    expect(stubbedCount).toBe(0);
    expect(messages).toBe(history);
  });
});
