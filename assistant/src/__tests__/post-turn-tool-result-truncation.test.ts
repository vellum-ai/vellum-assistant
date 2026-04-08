import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ContentBlock, Message } from "../providers/types.js";
import {
  THRESHOLD_CHARS,
  TARGET_CHARS,
  TOOL_RESULT_DIR,
  TRUNCATION_MARKER,
  buildTruncatedContent,
  getToolResultFilePath,
  postTurnTruncateToolResults,
} from "../context/post-turn-tool-result-truncation.js";

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

function makeMessages(blocks: ContentBlock[]): Message[] {
  return [{ role: "user", content: blocks }];
}

describe("postTurnTruncateToolResults", () => {
  let convDir: string;

  beforeEach(() => {
    convDir = mkdtempSync(join(tmpdir(), "tool-result-trunc-"));
  });

  afterEach(() => {
    rmSync(convDir, { recursive: true, force: true });
  });

  test("result below threshold is returned unchanged, no file written", () => {
    const shortContent = "a".repeat(THRESHOLD_CHARS);
    const messages = makeMessages([makeToolResult(shortContent)]);

    const { messages: result, truncatedCount } =
      postTurnTruncateToolResults(messages, { conversationDir: convDir });

    expect(truncatedCount).toBe(0);
    expect(result).toBe(messages); // same reference — no copy
    expect(existsSync(join(convDir, TOOL_RESULT_DIR))).toBe(false);
  });

  test("result above threshold is truncated, file written with original content", () => {
    const longContent = "x".repeat(THRESHOLD_CHARS + 1);
    const toolUseId = "tool_use_abc";
    const messages = makeMessages([makeToolResult(longContent, toolUseId)]);

    const { messages: result, truncatedCount } =
      postTurnTruncateToolResults(messages, { conversationDir: convDir });

    expect(truncatedCount).toBe(1);

    const block = result[0].content[0] as { type: "tool_result"; content: string };
    expect(block.content).toContain(TRUNCATION_MARKER);
    expect(block.content.length).toBeLessThan(longContent.length);

    // Verify file on disk contains original content.
    const filePath = getToolResultFilePath(convDir, toolUseId);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe(longContent);
  });

  test("error result above threshold is unchanged", () => {
    const longContent = "e".repeat(THRESHOLD_CHARS + 100);
    const messages = makeMessages([
      makeToolResult(longContent, "tool_err", true),
    ]);

    const { messages: result, truncatedCount } =
      postTurnTruncateToolResults(messages, { conversationDir: convDir });

    expect(truncatedCount).toBe(0);
    expect(result).toBe(messages);
  });

  test("already-truncated result is unchanged (idempotency)", () => {
    // Simulate a result that was already truncated in a prior pass.
    const alreadyTruncated =
      "prefix..." +
      `\n\n...(500 tokens omitted ${TRUNCATION_MARKER} /some/path.txt)\n\n` +
      "...suffix".padEnd(THRESHOLD_CHARS + 1, "z");
    const messages = makeMessages([
      makeToolResult(alreadyTruncated, "tool_idempotent"),
    ]);

    const { messages: result, truncatedCount } =
      postTurnTruncateToolResults(messages, { conversationDir: convDir });

    expect(truncatedCount).toBe(0);
    expect(result).toBe(messages);
  });

  test("multiple results in one turn are each evaluated independently", () => {
    const short = "s".repeat(100);
    const long1 = "a".repeat(THRESHOLD_CHARS + 1);
    const long2 = "b".repeat(THRESHOLD_CHARS + 2);
    const messages = makeMessages([
      makeToolResult(short, "tool_short"),
      makeToolResult(long1, "tool_long1"),
      makeToolResult(long2, "tool_long2"),
    ]);

    const { messages: result, truncatedCount } =
      postTurnTruncateToolResults(messages, { conversationDir: convDir });

    expect(truncatedCount).toBe(2);

    // Short result unchanged.
    const b0 = result[0].content[0] as { type: "tool_result"; content: string };
    expect(b0.content).toBe(short);

    // Both long results truncated.
    const b1 = result[0].content[1] as { type: "tool_result"; content: string };
    const b2 = result[0].content[2] as { type: "tool_result"; content: string };
    expect(b1.content).toContain(TRUNCATION_MARKER);
    expect(b2.content).toContain(TRUNCATION_MARKER);
  });

  test("prefix/suffix split preserves first and last halves of TARGET_CHARS", () => {
    // Build content where each char is its position modulo 10 so we can verify slicing.
    const longContent = Array.from({ length: THRESHOLD_CHARS + 500 }, (_, i) =>
      String(i % 10),
    ).join("");

    const filePath = "/tmp/fake-path.txt";
    const stub = buildTruncatedContent(longContent, filePath);

    const half = Math.floor(TARGET_CHARS / 2);
    const expectedPrefix = longContent.slice(0, half);
    const expectedSuffix = longContent.slice(-half);

    expect(stub.startsWith(expectedPrefix)).toBe(true);
    expect(stub.endsWith(expectedSuffix)).toBe(true);
    expect(stub).toContain(TRUNCATION_MARKER);
    expect(stub).toContain(filePath);
  });

  test("file path is deterministic for the same toolUseId", () => {
    const id = "tool_use_deterministic";
    const path1 = getToolResultFilePath("/some/dir", id);
    const path2 = getToolResultFilePath("/some/dir", id);
    expect(path1).toBe(path2);

    // Different IDs produce different paths.
    const path3 = getToolResultFilePath("/some/dir", "tool_use_other");
    expect(path3).not.toBe(path1);
  });
});
