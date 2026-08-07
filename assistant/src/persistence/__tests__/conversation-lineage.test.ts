/**
 * Guards over the lineage walk that gives referential forks their message
 * history. The stop conditions carry the weight here: each one degrades to a
 * SHORTER lineage, and the tests pin that direction, because the opposite
 * failure (walking past a missing bound, or following a cloned fork's parent
 * pointer) splices in rows the conversation must not show.
 */

import { describe, expect, test } from "bun:test";

import {
  isReferentialFork,
  isSingleSegmentLineage,
  type LineageBound,
  type LineageConversationRow,
  MAX_LINEAGE_DEPTH,
  resolveConversationLineage,
} from "../conversation-lineage.js";

function row(
  id: string,
  overrides: Partial<LineageConversationRow> = {},
): LineageConversationRow {
  return {
    id,
    forkStrategy: null,
    forkParentConversationId: null,
    forkParentMessageId: null,
    ...overrides,
  };
}

function referential(
  id: string,
  parentId: string,
  forkMessageId: string,
): LineageConversationRow {
  return row(id, {
    forkStrategy: "reference",
    forkParentConversationId: parentId,
    forkParentMessageId: forkMessageId,
  });
}

/** Resolver over in-memory maps, standing in for the two DB lookups. */
function resolverFor(
  rows: LineageConversationRow[],
  bounds: Record<string, LineageBound> = {},
) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    loadConversation: (id: string) => byId.get(id) ?? null,
    loadMessageBound: (messageId: string) => bounds[messageId] ?? null,
  };
}

describe("isReferentialFork", () => {
  test("a null fork_strategy reads as cloning, so legacy forks stop the walk", () => {
    expect(
      isReferentialFork({
        forkStrategy: null,
        forkParentConversationId: "parent",
        forkParentMessageId: "m1",
      }),
    ).toBe(false);
  });

  test("reference without both pointers is not referential", () => {
    expect(
      isReferentialFork({
        forkStrategy: "reference",
        forkParentConversationId: null,
        forkParentMessageId: "m1",
      }),
    ).toBe(false);
    expect(
      isReferentialFork({
        forkStrategy: "reference",
        forkParentConversationId: "parent",
        forkParentMessageId: null,
      }),
    ).toBe(false);
  });
});

describe("resolveConversationLineage", () => {
  test("a plain conversation is one unbounded segment", () => {
    const segments = resolveConversationLineage("c1", resolverFor([row("c1")]));

    expect(segments).toEqual([{ conversationId: "c1", through: null }]);
    expect(isSingleSegmentLineage(segments)).toBe(true);
  });

  test("a referential fork adds its parent bounded at the fork message", () => {
    const segments = resolveConversationLineage(
      "fork",
      resolverFor([referential("fork", "src", "m5"), row("src")], {
        m5: { createdAt: 500, id: "m5" },
      }),
    );

    expect(segments).toEqual([
      { conversationId: "fork", through: null },
      { conversationId: "src", through: { createdAt: 500, id: "m5" } },
    ]);
  });

  test("a cloned fork stops the walk so its copied prefix is not read twice", () => {
    const cloned = row("fork", {
      forkStrategy: "cloning",
      forkParentConversationId: "src",
      forkParentMessageId: "m5",
    });

    const segments = resolveConversationLineage(
      "fork",
      resolverFor([cloned, row("src")], { m5: { createdAt: 500, id: "m5" } }),
    );

    expect(isSingleSegmentLineage(segments)).toBe(true);
  });

  test("a fork of a referential fork walks the whole chain", () => {
    const segments = resolveConversationLineage(
      "c",
      resolverFor(
        [referential("c", "b", "m9"), referential("b", "a", "m4"), row("a")],
        {
          m9: { createdAt: 900, id: "m9" },
          m4: { createdAt: 400, id: "m4" },
        },
      ),
    );

    expect(segments.map((s) => s.conversationId)).toEqual(["c", "b", "a"]);
    expect(segments[2]!.through).toEqual({ createdAt: 400, id: "m4" });
  });

  test("a nested fork tightens ancestor bounds instead of widening them", () => {
    // C forks B through m2, a row B inherited from A and which sits BEFORE
    // B's own fork point m4. Carrying B's m4 into A's segment would re-expose
    // m3 and m4, which C explicitly forked before.
    const segments = resolveConversationLineage(
      "c",
      resolverFor(
        [referential("c", "b", "m2"), referential("b", "a", "m4"), row("a")],
        {
          m2: { createdAt: 200, id: "m2" },
          m4: { createdAt: 400, id: "m4" },
        },
      ),
    );

    expect(segments).toEqual([
      { conversationId: "c", through: null },
      { conversationId: "b", through: { createdAt: 200, id: "m2" } },
      { conversationId: "a", through: { createdAt: 200, id: "m2" } },
    ]);
  });

  test("a nested fork keeps the ancestor's own bound when it is the tighter one", () => {
    // The mirror case: C forks B through m9, past B's fork point m4, so A's
    // contribution stays capped at m4 rather than loosening to m9.
    const segments = resolveConversationLineage(
      "c",
      resolverFor(
        [referential("c", "b", "m9"), referential("b", "a", "m4"), row("a")],
        {
          m9: { createdAt: 900, id: "m9" },
          m4: { createdAt: 400, id: "m4" },
        },
      ),
    );

    expect(segments[2]!.through).toEqual({ createdAt: 400, id: "m4" });
  });

  test("bounds sharing a millisecond tighten on id", () => {
    const segments = resolveConversationLineage(
      "c",
      resolverFor(
        [
          referential("c", "b", "m-aaa"),
          referential("b", "a", "m-zzz"),
          row("a"),
        ],
        {
          "m-aaa": { createdAt: 500, id: "m-aaa" },
          "m-zzz": { createdAt: 500, id: "m-zzz" },
        },
      ),
    );

    expect(segments[2]!.through).toEqual({ createdAt: 500, id: "m-aaa" });
  });

  test("a vanished fork message truncates instead of splicing in all of the parent", () => {
    // Without the bound there is nothing scoping the parent's contribution, so
    // continuing would pull in messages written AFTER the fork was taken.
    const segments = resolveConversationLineage(
      "fork",
      resolverFor([referential("fork", "src", "gone"), row("src")]),
    );

    expect(isSingleSegmentLineage(segments)).toBe(true);
  });

  test("a deleted parent truncates the lineage", () => {
    const segments = resolveConversationLineage(
      "fork",
      resolverFor([referential("fork", "src", "m5")], {
        m5: { createdAt: 500, id: "m5" },
      }),
    );

    expect(isSingleSegmentLineage(segments)).toBe(true);
  });

  test("a pointer cycle terminates instead of spinning", () => {
    const segments = resolveConversationLineage(
      "a",
      resolverFor([referential("a", "b", "m2"), referential("b", "a", "m1")], {
        m1: { createdAt: 100, id: "m1" },
        m2: { createdAt: 200, id: "m2" },
      }),
    );

    expect(segments.map((s) => s.conversationId)).toEqual(["a", "b"]);
  });

  test("the walk is bounded at MAX_LINEAGE_DEPTH", () => {
    const chainLength = MAX_LINEAGE_DEPTH + 10;
    const rows: LineageConversationRow[] = [];
    const bounds: Record<string, LineageBound> = {};
    for (let i = 0; i < chainLength; i++) {
      rows.push(referential(`c${i}`, `c${i + 1}`, `m${i}`));
      bounds[`m${i}`] = { createdAt: i, id: `m${i}` };
    }
    rows.push(row(`c${chainLength}`));

    const segments = resolveConversationLineage(
      "c0",
      resolverFor(rows, bounds),
    );

    expect(segments).toHaveLength(MAX_LINEAGE_DEPTH);
  });
});
