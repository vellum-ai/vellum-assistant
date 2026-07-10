/**
 * Tests for the file-backed message content module: the JSONL delta fold
 * semantics, the append/fold roundtrip, the reserved-path ref discriminator,
 * and both resolver forms (expressive `ContentBlock[]` and the row-mapper
 * string shim) across inline passthrough, ref resolution, missing-file and
 * workspace-escape fallbacks.
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
  resolveMessageContentBlocks,
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
      JSON.stringify({ i: 2, seq: 4, block: { typo: "no type field" } }) +
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
  test("accepts exactly { ref } naming a reserved conversations/ .jsonl path", () => {
    expect(
      isMessageContentRef({ ref: "conversations/a/inflight/b.jsonl" }),
    ).toBe(true);
  });

  test("rejects non-reserved paths — the legacy-text discriminator", () => {
    expect(isMessageContentRef({ ref: "a/b.jsonl" })).toBe(false);
    expect(isMessageContentRef({ ref: "conversations/a/b.txt" })).toBe(false);
    expect(isMessageContentRef({ ref: "/etc/passwd" })).toBe(false);
    expect(isMessageContentRef({ ref: "../../../etc/passwd" })).toBe(false);
  });

  test("rejects arrays, extra keys, empty and non-string refs", () => {
    expect(isMessageContentRef([textBlock("x")])).toBe(false);
    expect(
      isMessageContentRef({ ref: "conversations/a/b.jsonl", other: 1 }),
    ).toBe(false);
    expect(isMessageContentRef({ ref: "" })).toBe(false);
    expect(isMessageContentRef({ ref: 42 })).toBe(false);
    expect(isMessageContentRef(null)).toBe(false);
  });
});

function writeRefFixture(dir: string, file: string): string {
  const rel = join("conversations", dir, "inflight", file);
  mkdirSync(join(getWorkspaceDir(), "conversations", dir, "inflight"), {
    recursive: true,
  });
  writeFileSync(
    join(getWorkspaceDir(), rel),
    [
      JSON.stringify({ i: 0, seq: 1, block: textBlock("partial") }),
      JSON.stringify({ i: 0, seq: 2, block: textBlock("final") }),
    ].join("\n") + "\n",
  );
  return rel;
}

describe("resolveStoredMessageContent (row-mapper string shim)", () => {
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

  test("passes legacy text shaped like a ref to a NON-reserved path through untouched", () => {
    const legacyRefLikeText = JSON.stringify({ ref: "missing.jsonl" });
    expect(resolveStoredMessageContent(legacyRefLikeText)).toBe(
      legacyRefLikeText,
    );
  });

  test("resolves a reserved-path ref to the folded file content", () => {
    const rel = writeRefFixture("test-resolve", "m.jsonl");
    expect(resolveStoredMessageContent(JSON.stringify({ ref: rel }))).toBe(
      JSON.stringify([textBlock("final")]),
    );
  });

  test("resolves a reserved-path ref to a missing file as empty content", () => {
    expect(
      resolveStoredMessageContent(
        JSON.stringify({ ref: "conversations/gone/inflight/m.jsonl" }),
      ),
    ).toBe("[]");
  });

  test("resolves a reserved-prefix ref that escapes the workspace as empty content", () => {
    expect(
      resolveStoredMessageContent(
        JSON.stringify({ ref: "conversations/../../../etc/evil.jsonl" }),
      ),
    ).toBe("[]");
  });
});

describe("resolveMessageContentBlocks (expressive form)", () => {
  test("parses inline ContentBlock[] JSON to blocks", () => {
    expect(
      resolveMessageContentBlocks(JSON.stringify([textBlock("hello")])),
    ).toEqual([textBlock("hello")]);
  });

  test("folds a reserved-path ref to blocks", () => {
    const rel = writeRefFixture("test-resolve-blocks", "m.jsonl");
    expect(resolveMessageContentBlocks(JSON.stringify({ ref: rel }))).toEqual([
      textBlock("final"),
    ]);
  });

  test("wraps legacy plain strings in a single text block", () => {
    expect(resolveMessageContentBlocks("plain old text")).toEqual([
      textBlock("plain old text"),
    ]);
    const legacyRefLikeText = JSON.stringify({ ref: "missing.jsonl" });
    expect(resolveMessageContentBlocks(legacyRefLikeText)).toEqual([
      textBlock(legacyRefLikeText),
    ]);
  });

  test("resolves a missing ref file to empty blocks", () => {
    expect(
      resolveMessageContentBlocks(
        JSON.stringify({ ref: "conversations/gone/inflight/m.jsonl" }),
      ),
    ).toEqual([]);
  });
});
