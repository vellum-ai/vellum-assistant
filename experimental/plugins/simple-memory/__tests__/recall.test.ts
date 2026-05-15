/**
 * Behavioral tests for `simple_memory_recall`.
 *
 * Lives with the plugin (not the daemon) — plugin-owned tests should
 * exercise plugin code without round-tripping through the daemon
 * runtime. The assistant's `bun test` discovers this file via the
 * widened glob in `assistant/scripts/test.sh`.
 *
 * `@vellumai/plugin-api` is type-only here (and inside the plugin's
 * source), so runtime resolution is never attempted under bun test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import recallTool from "../tools/recall.ts";
import {
  appendEntry,
  clearState,
  type MemoryEntry,
  newEntryId,
  setState,
} from "../src/state.ts";

function ctx(conversationId: string) {
  return { conversationId, workingDir: process.cwd() };
}

function silentLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

function makeEntry(
  conversationId: string,
  text: string,
  createdAt: number,
): MemoryEntry {
  return {
    id: newEntryId(),
    conversationId,
    text,
    createdAt,
  };
}

function seed(entries: MemoryEntry[]): void {
  setState({
    storePath: "/dev/null",
    entries: [],
    logger: silentLogger(),
  });
  for (const entry of entries) {
    appendEntry(entry);
  }
}

describe("simple_memory_recall — search behavior", () => {
  beforeEach(() => {
    clearState();
  });
  afterEach(() => {
    clearState();
  });

  test("input_schema advertises a required `query` parameter", () => {
    expect(recallTool.name).toBe("simple_memory_recall");
    const schema = recallTool.input_schema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.required).toContain("query");
    expect(schema.properties.query).toBeDefined();
  });

  test("missing/empty query returns an error result", async () => {
    seed([]);
    const r1 = await recallTool.execute({}, ctx("conv-a"));
    expect(r1.isError).toBe(true);
    expect(r1.content).toMatch(/non-empty/);

    const r2 = await recallTool.execute({ query: "   " }, ctx("conv-a"));
    expect(r2.isError).toBe(true);
  });

  test("invalid regex returns an error result", async () => {
    seed([]);
    const r = await recallTool.execute(
      { query: "[unterminated" },
      ctx("conv-a"),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/invalid regex/);
  });

  test("no matches returns a deterministic message (no error)", async () => {
    seed([makeEntry("conv-a", "Vargas prefers terse register", 1_000)]);
    const r = await recallTool.execute(
      { query: "nothing-like-this" },
      ctx("conv-a"),
    );
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/no matches for: nothing-like-this/);
  });

  test("matches across conversations, ordered newest-first", async () => {
    seed([
      makeEntry("conv-old", "vargas likes coffee", 1_000),
      makeEntry("conv-other", "vargas takes the F train", 5_000),
      makeEntry("conv-active", "vargas likes tea", 9_000),
      makeEntry("conv-noise", "the weather is nice", 7_000),
    ]);
    const r = await recallTool.execute({ query: "vargas" }, ctx("conv-active"));
    expect(r.isError).toBe(false);
    const lines = r.content.split("\n");
    expect(lines).toHaveLength(3);
    // Newest first.
    const firstFields = lines[0].split("\t");
    expect(firstFields[3]).toBe("vargas likes tea");
    // Scope column: active conversation reads `current`, others read the
    // source conversation id.
    expect(firstFields[2]).toBe("current");
    expect(lines[1].split("\t")[2]).toBe("conv-other");
    expect(lines[2].split("\t")[2]).toBe("conv-old");
  });

  test("scope column marks `current` for the active conversation", async () => {
    seed([
      makeEntry("conv-active", "alpha note", 1_000),
      makeEntry("conv-other", "alpha note again", 2_000),
    ]);
    const r = await recallTool.execute({ query: "alpha" }, ctx("conv-active"));
    const lines = r.content.split("\n");
    expect(lines).toHaveLength(2);
    // Newest first: conv-other is newer.
    expect(lines[0].split("\t")[2]).toBe("conv-other");
    expect(lines[1].split("\t")[2]).toBe("current");
  });

  test("case-insensitive regex matching", async () => {
    seed([
      makeEntry("conv-a", "Apollo deployed PR-5 today", 1_000),
      makeEntry("conv-a", "the cherry-pick was clean", 2_000),
    ]);
    const r = await recallTool.execute({ query: "apollo" }, ctx("conv-a"));
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/Apollo deployed PR-5 today/);
    expect(r.content).not.toMatch(/cherry-pick/);
  });

  test("regex metacharacters are honored (alternation, word boundary)", async () => {
    seed([
      makeEntry("conv-a", "vargas likes apples", 1_000),
      makeEntry("conv-a", "vargas likes oranges", 2_000),
      makeEntry("conv-a", "vargas likes pears", 3_000),
      makeEntry("conv-a", "applesauce is fine", 4_000),
    ]);
    // Unanchored alternation: `apples|oranges` matches both the apples /
    // oranges entries AND the "applesauce" entry (substring). That's the
    // regex contract; the word-boundary assertion below filters it out.
    const alt = await recallTool.execute(
      { query: "apples|oranges" },
      ctx("conv-a"),
    );
    const altLines = alt.content.split("\n");
    expect(altLines).toHaveLength(3);
    expect(alt.content).toMatch(/applesauce is fine/);
    expect(alt.content).toMatch(/vargas likes oranges/);
    expect(alt.content).toMatch(/vargas likes apples/);
    expect(alt.content).not.toMatch(/pears/);

    const wb = await recallTool.execute(
      { query: "\\bapples\\b" },
      ctx("conv-a"),
    );
    const wbLines = wb.content.split("\n");
    expect(wbLines).toHaveLength(1);
    expect(wbLines[0]).toMatch(/vargas likes apples/);
    expect(wb.content).not.toMatch(/applesauce/);
  });

  test("respects an explicit `limit` and caps at the maximum", async () => {
    const entries: MemoryEntry[] = [];
    for (let i = 0; i < 150; i++) {
      entries.push(makeEntry("conv-a", `vargas note ${i}`, 1_000 + i));
    }
    seed(entries);

    const small = await recallTool.execute(
      { query: "vargas", limit: 3 },
      ctx("conv-a"),
    );
    expect(small.content.split("\n")).toHaveLength(3);

    const huge = await recallTool.execute(
      { query: "vargas", limit: 9_999 },
      ctx("conv-a"),
    );
    // Max cap is 100.
    expect(huge.content.split("\n")).toHaveLength(100);

    const fractional = await recallTool.execute(
      { query: "vargas", limit: 2.7 },
      ctx("conv-a"),
    );
    expect(fractional.content.split("\n")).toHaveLength(2);

    const zero = await recallTool.execute(
      { query: "vargas", limit: 0 },
      ctx("conv-a"),
    );
    // Floor of 1.
    expect(zero.content.split("\n")).toHaveLength(1);
  });
});
