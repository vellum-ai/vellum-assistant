/**
 * Behavioral test for the simple-memory plugin's `simple_memory_recall` tool
 * after its conversion from "list entries in this conversation" to "search
 * across all entries". Imports the on-disk plugin's tool file directly so
 * the test fails if the type imports (`@vellumai/plugin-api`) regress, the
 * search wiring breaks, or the description copy drifts in a way that no
 * longer describes a search tool.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  appendEntry,
  clearState,
  type MemoryEntry,
  newEntryId,
  setState,
} from "../../../experimental/plugins/simple-memory/src/state.js";
import recallTool from "../../../experimental/plugins/simple-memory/tools/recall.js";

interface ToolCtxShape {
  conversationId: string;
  workingDir: string;
}

function ctx(conversationId: string): ToolCtxShape {
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
  return { id: newEntryId(), conversationId, text, createdAt };
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

  test("getDefinition advertises a required `query` parameter", () => {
    const def = recallTool.getDefinition();
    expect(def.name).toBe("simple_memory_recall");
    const schema = def.input_schema as {
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

  test("no matches returns a deterministic message (no error)", async () => {
    seed([makeEntry("conv-a", "Vargas prefers terse register", 1_000)]);
    const r = await recallTool.execute({ query: "nothing-like-this" }, ctx("conv-a"));
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/no matches for: nothing-like-this/);
  });

  test("matches across conversations, ordered newest-first", async () => {
    seed([
      makeEntry("conv-old", "vargas likes coffee", 1_000),
      makeEntry("conv-other", "vargas takes the F train", 5_000),
      makeEntry("conv-new", "vargas likes tea", 9_000),
      makeEntry("conv-noise", "the weather is nice", 7_000),
    ]);
    const r = await recallTool.execute({ query: "vargas" }, ctx("conv-active"));
    expect(r.isError).toBe(false);
    const lines = r.content.split("\n");
    expect(lines).toHaveLength(3);
    // Newest first.
    const firstFields = lines[0].split("\t");
    expect(firstFields[3]).toBe("vargas likes tea");
    // Each line surfaces the conversation id (column 3).
    expect(firstFields[2]).toBe("conv-new");
    expect(lines[1].split("\t")[2]).toBe("conv-other");
    expect(lines[2].split("\t")[2]).toBe("conv-old");
  });

  test("case-insensitive substring match", async () => {
    seed([
      makeEntry("conv-a", "Apollo deployed PR-5 today", 1_000),
      makeEntry("conv-a", "the cherry-pick was clean", 2_000),
    ]);
    const r = await recallTool.execute({ query: "apollo" }, ctx("conv-a"));
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/Apollo deployed PR-5 today/);
    expect(r.content).not.toMatch(/cherry-pick/);
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
