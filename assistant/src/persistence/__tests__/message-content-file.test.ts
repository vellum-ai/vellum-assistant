/**
 * Tests for the file-backed message content module: the JSONL delta fold
 * semantics, the append/fold roundtrip, and `resolveStoredMessageContent`'s
 * union handling (inline passthrough, ref resolution, missing-file and
 * workspace-escape fallbacks).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import type { ContentBlock } from "../../providers/types.js";
import { getWorkspaceDir } from "../../util/platform.js";
import {
  appendContentDeltas,
  foldContentDeltas,
  foldContentFile,
  isMessageContentRef,
  resolveStoredMessageContent,
} from "../message-content-file.js";

function textBlock(text: string): ContentBlock {
  return { type: "text", text } as ContentBlock;
}

describe("foldContentDeltas", () => {
  test("keeps the highest-seq line per index, ordered by index", () => {
    const lines = [
      { i: 1, seq: 1, block: textBlock("second, v1") },
      { i: 0, seq: 2, block: textBlock("first, v1") },
      { i: 1, seq: 3, block: textBlock("second, v2") },
      { i: 0, seq: 0, block: textBlock("first, stale") },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    expect(foldContentDeltas(lines)).toEqual([
      textBlock("first, v1"),
      textBlock("second, v2"),
    ]);
  });

  test("skips malformed and crash-truncated lines", () => {
    const text =
      JSON.stringify({ i: 0, seq: 1, block: textBlock("kept") }) +
      "\n" +
      "not json\n" +
      JSON.stringify({ seq: 2, block: textBlock("missing index") }) +
      "\n" +
      '{"i": 1, "seq": 3, "block": {"type": "text", "te'; // truncated
    expect(foldContentDeltas(text)).toEqual([textBlock("kept")]);
  });

  test("empty input folds to empty content", () => {
    expect(foldContentDeltas("")).toEqual([]);
  });
});

describe("appendContentDeltas + foldContentFile", () => {
  test("roundtrips across multiple appends, creating parent dirs", () => {
    const path = join(
      getWorkspaceDir(),
      "conversations",
      "test-roundtrip",
      "inflight",
      "msg-1.jsonl",
    );
    appendContentDeltas(path, [{ i: 0, seq: 1, block: textBlock("hel") }]);
    appendContentDeltas(path, [
      { i: 0, seq: 2, block: textBlock("hello") },
      { i: 1, seq: 3, block: textBlock("world") },
    ]);
    expect(foldContentFile(path)).toEqual([
      textBlock("hello"),
      textBlock("world"),
    ]);
  });

  test("returns null for a missing file", () => {
    expect(
      foldContentFile(join(getWorkspaceDir(), "does-not-exist.jsonl")),
    ).toBeNull();
  });
});

describe("isMessageContentRef", () => {
  test("accepts exactly { ref: string }", () => {
    expect(isMessageContentRef({ ref: "a/b.jsonl" })).toBe(true);
  });

  test("rejects arrays, extra keys, empty and non-string refs", () => {
    expect(isMessageContentRef([textBlock("x")])).toBe(false);
    expect(isMessageContentRef({ ref: "a", other: 1 })).toBe(false);
    expect(isMessageContentRef({ ref: "" })).toBe(false);
    expect(isMessageContentRef({ ref: 42 })).toBe(false);
    expect(isMessageContentRef(null)).toBe(false);
  });
});

describe("resolveStoredMessageContent", () => {
  test("passes inline ContentBlock[] JSON through by identity", () => {
    const inline = JSON.stringify([textBlock("hello")]);
    expect(resolveStoredMessageContent(inline)).toBe(inline);
  });

  test("passes legacy plain strings through, including '{'-prefixed ones", () => {
    expect(resolveStoredMessageContent("plain old text")).toBe(
      "plain old text",
    );
    expect(resolveStoredMessageContent("{not json")).toBe("{not json");
    const objectButNotRef = JSON.stringify({ some: "object" });
    expect(resolveStoredMessageContent(objectButNotRef)).toBe(objectButNotRef);
  });

  test("resolves a ref to the folded file content", () => {
    const rel = join("conversations", "test-resolve", "inflight", "m.jsonl");
    const abs = join(getWorkspaceDir(), rel);
    mkdirSync(
      join(getWorkspaceDir(), "conversations", "test-resolve", "inflight"),
      {
        recursive: true,
      },
    );
    writeFileSync(
      abs,
      [
        JSON.stringify({ i: 0, seq: 1, block: textBlock("partial") }),
        JSON.stringify({ i: 0, seq: 2, block: textBlock("final") }),
      ].join("\n") + "\n",
    );
    expect(resolveStoredMessageContent(JSON.stringify({ ref: rel }))).toBe(
      JSON.stringify([textBlock("final")]),
    );
  });

  test("resolves a ref to a missing file as empty content", () => {
    expect(
      resolveStoredMessageContent(JSON.stringify({ ref: "gone/m.jsonl" })),
    ).toBe("[]");
  });

  test("rejects refs that escape the workspace directory", () => {
    expect(
      resolveStoredMessageContent(
        JSON.stringify({ ref: "../../../etc/passwd" }),
      ),
    ).toBe("[]");
    expect(
      resolveStoredMessageContent(JSON.stringify({ ref: "/etc/passwd" })),
    ).toBe("[]");
  });
});
