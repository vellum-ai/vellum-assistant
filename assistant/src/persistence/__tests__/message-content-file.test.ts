/**
 * Tests for the file-backed message content module: the JSONL delta fold
 * semantics, the append/fold roundtrip, the reserved-path ref discriminator,
 * and the `resolveMessageContentBlocks` resolver across inline content,
 * ref resolution, legacy plain strings, missing-file and workspace-escape
 * fallbacks.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { contentBlockArraySchema } from "../../providers/content-block-schema.js";
import type { ContentBlock } from "../../providers/types.js";
import { getWorkspaceDir } from "../../util/platform.js";
import {
  appendContentDeltas,
  foldContentDeltas,
  foldContentFile,
  messageContentRefSchema,
  resolveMessageContentBlocks,
} from "../message-content-file.js";

function textBlock(text: string): ContentBlock {
  return { type: "text", text };
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

  test("preserves internal rider fields on blocks (passthrough, not strip)", () => {
    // Timing stamps like _startedAt ride inside persisted thinking blocks;
    // the fold must round-trip them, not strip them as unknown keys.
    const stamped = {
      type: "thinking",
      thinking: "hmm",
      signature: "sig",
      _startedAt: 123,
    };
    const text = JSON.stringify({ i: 0, seq: 1, block: stamped });
    expect(foldContentDeltas(text)).toEqual([stamped as ContentBlock]);
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

describe("messageContentRefSchema", () => {
  test("accepts exactly { ref } naming a reserved conversations/ .jsonl path", () => {
    expect(
      messageContentRefSchema.safeParse({
        ref: "conversations/a/inflight/b.jsonl",
      }).success,
    ).toBe(true);
  });

  test("rejects non-reserved paths — the legacy-text discriminator", () => {
    for (const ref of [
      "a/b.jsonl",
      "conversations/a/b.txt",
      "/etc/passwd",
      "../../../etc/passwd",
    ]) {
      expect(messageContentRefSchema.safeParse({ ref }).success).toBe(false);
    }
  });

  test("strips unrecognized extra keys rather than rejecting them", () => {
    const result = messageContentRefSchema.safeParse({
      ref: "conversations/a/b.jsonl",
      other: 1,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ ref: "conversations/a/b.jsonl" });
    }
  });

  test("rejects arrays, empty and non-string refs", () => {
    for (const value of [[textBlock("x")], { ref: "" }, { ref: 42 }, null]) {
      expect(messageContentRefSchema.safeParse(value).success).toBe(false);
    }
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

describe("resolveMessageContentBlocks", () => {
  test("parses inline ContentBlock[] JSON to blocks", () => {
    expect(
      resolveMessageContentBlocks(JSON.stringify([textBlock("hello")])),
    ).toEqual([textBlock("hello")]);
  });

  test("parses a nested tool_result with contentBlocks (recursive schema)", () => {
    const blocks: ContentBlock[] = [
      {
        type: "tool_result",
        tool_use_id: "tu-1",
        content: "done",
        contentBlocks: [textBlock("nested")],
      },
    ];
    expect(resolveMessageContentBlocks(JSON.stringify(blocks))).toEqual(blocks);
  });

  test("passes typed blocks outside the union through untouched", () => {
    // A persisted kind the union does not model still passes through: its
    // renderer owns the shape, so repair must not rewrite it.
    const historical = [
      textBlock("kept as-is"),
      { type: "some_retired_block_kind", payload: 1 },
    ];
    expect(resolveMessageContentBlocks(JSON.stringify(historical))).toEqual(
      historical as ContentBlock[],
    );
  });

  test("validates ui_surface blocks without entering the repair path", () => {
    // ui_surface is a first-class union member (LUM-2869). Before it was
    // modelled, every read of a row holding a card failed schema validation
    // and paid a per-block repair that changed nothing — the read-path noise
    // that spiked with voice GA. Asserting schema success (not just a clean
    // round trip) is what proves the repair path can no longer fire, since
    // repair passes these blocks through unchanged either way.
    const surfaceRow = [
      {
        type: "ui_surface",
        surfaceId: "call-1",
        surfaceType: "call_summary",
        completed: true,
        display: "inline",
        data: { summaryText: "**Call completed** (42s).", events: [] },
      },
      {
        type: "text",
        text: "**Call completed** (42s).",
        _surfaceFallback: true,
      },
    ];
    expect(contentBlockArraySchema.safeParse(surfaceRow).success).toBe(true);
    // `data` stays opaque and internal riders survive the round trip.
    expect(resolveMessageContentBlocks(JSON.stringify(surfaceRow))).toEqual(
      surfaceRow as unknown as ContentBlock[],
    );
  });

  test("validates an LLM-emitted surface with an arbitrary display value", () => {
    // Surfaces written by the `ui_show` tool carry whatever the model chose:
    // `CurrentTurnSurface.display` is a bare string, NOT the inline/panel enum
    // of the `ui_surface_show` wire event. Narrowing it here would send every
    // LLM surface back through the per-block repair — the read-path noise this
    // variant exists to stop. Daemon-only riders must survive too.
    const llmSurfaceRow = [
      {
        type: "ui_surface",
        surfaceId: "surface-1",
        surfaceType: "card",
        title: "Pick one",
        data: { title: "Pick one", options: ["a", "b"] },
        actions: [{ id: "a", label: "A" }],
        display: "modal",
        persistent: true,
        toolCallId: "tu-1",
        activationMoment: "commit",
      },
    ];
    expect(contentBlockArraySchema.safeParse(llmSurfaceRow).success).toBe(true);
    expect(resolveMessageContentBlocks(JSON.stringify(llmSurfaceRow))).toEqual(
      llmSurfaceRow as unknown as ContentBlock[],
    );
  });

  test("wraps type-less values in a text block carrying the payload", () => {
    const historical = [{ payload: 1 }, "bare string"];
    expect(resolveMessageContentBlocks(JSON.stringify(historical))).toEqual([
      textBlock('{"payload":1}'),
      textBlock('"bare string"'),
    ]);
  });

  test("repairs a web_search_tool_result with a missing tool_use_id", () => {
    const historical = [
      { type: "web_search_tool_result", content: { encrypted: "blob" } },
    ];
    expect(resolveMessageContentBlocks(JSON.stringify(historical))).toEqual([
      {
        type: "web_search_tool_result",
        tool_use_id: "",
        content: { encrypted: "blob" },
      },
    ]);
  });

  test("repairs a text block with missing or non-string text", () => {
    const historical = [{ type: "text" }, { type: "text", text: 42 }];
    expect(resolveMessageContentBlocks(JSON.stringify(historical))).toEqual([
      textBlock(""),
      textBlock("42"),
    ]);
  });

  test("repairs a tool_result with object-valued content in place", () => {
    const historical = [
      { type: "tool_result", tool_use_id: "tu-1", content: { some: "obj" } },
    ];
    expect(resolveMessageContentBlocks(JSON.stringify(historical))).toEqual([
      {
        type: "tool_result",
        tool_use_id: "tu-1",
        content: '{"some":"obj"}',
      },
    ]);
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

  test("resolves a reserved-prefix ref that escapes the workspace to empty blocks", () => {
    expect(
      resolveMessageContentBlocks(
        JSON.stringify({ ref: "conversations/../../../etc/evil.jsonl" }),
      ),
    ).toEqual([]);
  });
});
