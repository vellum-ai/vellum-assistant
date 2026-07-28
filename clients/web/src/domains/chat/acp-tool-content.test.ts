import { describe, expect, it } from "bun:test";

import {
  formatRawValue,
  getAcpFileChanges,
  getAcpToolCommand,
  parseAcpToolContent,
  type AcpToolContentBlock,
} from "@/domains/chat/acp-tool-content";

describe("parseAcpToolContent", () => {
  it("parses an array of diff blocks", () => {
    const content = JSON.stringify([
      { type: "diff", path: "a.ts", newText: "new", oldText: "old" },
      { type: "diff", path: "b.ts", newText: "created" },
    ]);
    expect(parseAcpToolContent(content)).toEqual([
      { type: "diff", path: "a.ts", newText: "new", oldText: "old" },
      { type: "diff", path: "b.ts", newText: "created" },
    ]);
  });

  it("parses an array of content blocks (nested ContentBlock text)", () => {
    const content = JSON.stringify([
      { type: "content", content: { type: "text", text: "hello" } },
    ]);
    expect(parseAcpToolContent(content)).toEqual([
      { type: "content", text: "hello" },
    ]);
  });

  it("tolerates a single object instead of an array", () => {
    const content = JSON.stringify({
      type: "diff",
      path: "a.ts",
      newText: "new",
    });
    expect(parseAcpToolContent(content)).toEqual([
      { type: "diff", path: "a.ts", newText: "new" },
    ]);
  });

  it("maps terminal blocks without text", () => {
    const content = JSON.stringify([{ type: "terminal", terminalId: "t-1" }]);
    expect(parseAcpToolContent(content)).toEqual([{ type: "terminal" }]);
  });

  it("carries terminal text through when present", () => {
    const content = JSON.stringify([
      { type: "terminal", terminalId: "t-1", text: "$ ls\nfile.txt" },
    ]);
    expect(parseAcpToolContent(content)).toEqual([
      { type: "terminal", text: "$ ls\nfile.txt" },
    ]);
  });

  it("ignores unknown variants while keeping known ones", () => {
    const content = JSON.stringify([
      { type: "image", data: "..." },
      { type: "content", content: { type: "text", text: "kept" } },
    ]);
    expect(parseAcpToolContent(content)).toEqual([
      { type: "content", text: "kept" },
    ]);
  });

  it("returns [] for malformed JSON wrapped in braces", () => {
    expect(parseAcpToolContent("{not json")).toEqual([]);
  });

  it("returns [] for empty and undefined input", () => {
    expect(parseAcpToolContent("")).toEqual([]);
    expect(parseAcpToolContent(undefined)).toEqual([]);
  });

  it("falls back to a single content block for a plain non-JSON string", () => {
    expect(parseAcpToolContent("just some text")).toEqual([
      { type: "content", text: "just some text" },
    ]);
  });

  it("never throws on a JSON null", () => {
    expect(parseAcpToolContent("null")).toEqual([]);
  });
});

describe("getAcpFileChanges", () => {
  it("extracts changes from diff blocks alone", () => {
    const blocks: AcpToolContentBlock[] = [
      { type: "diff", path: "a.ts", newText: "new", oldText: "old" },
      { type: "content", text: "noise" },
      { type: "diff", path: "b.ts", newText: "created" },
    ];
    expect(getAcpFileChanges(blocks)).toEqual([
      { path: "a.ts", newText: "new", oldText: "old" },
      { path: "b.ts", newText: "created" },
    ]);
  });

  it("merges diff paths with extra locations, deduping by path", () => {
    const blocks: AcpToolContentBlock[] = [
      { type: "diff", path: "a.ts", newText: "new" },
    ];
    const locations = [{ path: "a.ts", line: 1 }, { path: "c.ts" }];
    expect(getAcpFileChanges(blocks, locations)).toEqual([
      { path: "a.ts", newText: "new" },
      { path: "c.ts" },
    ]);
  });

  it("returns path-only entries from locations when there are no diffs", () => {
    expect(getAcpFileChanges([], [{ path: "x.ts" }, { path: "y.ts" }])).toEqual(
      [{ path: "x.ts" }, { path: "y.ts" }],
    );
  });

  it("returns [] when there are no diffs and no locations", () => {
    expect(getAcpFileChanges([])).toEqual([]);
  });
});

describe("getAcpToolCommand", () => {
  it("returns the command from an object with a string command", () => {
    expect(getAcpToolCommand({ command: "npm test" })).toBe("npm test");
  });

  it("returns undefined for an object without a string command", () => {
    expect(getAcpToolCommand({ command: 42 })).toBeUndefined();
    expect(getAcpToolCommand({ other: "x" })).toBeUndefined();
  });

  it("returns undefined for non-object input", () => {
    expect(getAcpToolCommand("npm test")).toBeUndefined();
    expect(getAcpToolCommand(undefined)).toBeUndefined();
    expect(getAcpToolCommand(null)).toBeUndefined();
  });
});

describe("formatRawValue", () => {
  it("returns undefined for undefined and null", () => {
    expect(formatRawValue(undefined)).toBeUndefined();
    expect(formatRawValue(null)).toBeUndefined();
  });

  it("passes strings through verbatim", () => {
    expect(formatRawValue("hello")).toBe("hello");
  });

  it("pretty-prints objects as JSON", () => {
    expect(formatRawValue({ a: 1, b: "x" })).toBe(
      JSON.stringify({ a: 1, b: "x" }, null, 2),
    );
  });

  it("stringifies other primitives", () => {
    expect(formatRawValue(42)).toBe("42");
    expect(formatRawValue(true)).toBe("true");
  });

  it("falls back to String on a non-serializable (circular) object", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    // Must not throw; falls back rather than crashing the card render.
    expect(formatRawValue(circular)).toBe(String(circular));
  });
});
