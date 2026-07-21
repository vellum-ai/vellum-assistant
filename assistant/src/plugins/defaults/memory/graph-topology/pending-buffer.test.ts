import { describe, expect, test } from "bun:test";

import {
  buildPendingGraph,
  parseBufferEntries,
  PENDING_KIND,
  PENDING_NODE_ID_PREFIX,
} from "./pending-buffer.js";

describe("parseBufferEntries", () => {
  test("parses timestamped bullets into entries", () => {
    const entries = parseBufferEntries(
      "- [Jul 20, 3:15 PM] Alice prefers VS Code\n" +
        "- [Jul 20, 3:16 PM] Bob lives in Austin\n",
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]!.text).toBe("Alice prefers VS Code");
    expect(entries[1]!.text).toBe("Bob lives in Austin");
    expect(entries[0]!.id.startsWith(PENDING_NODE_ID_PREFIX)).toBe(true);
  });

  test("tolerates bullets without a timestamp and skips non-bullet lines", () => {
    const entries = parseBufferEntries(
      "# Buffer\n\n- plain fact\nnot a bullet\n- [Jul 20, 3:15 PM] stamped\n",
    );
    expect(entries.map((e) => e.text)).toEqual(["plain fact", "stamped"]);
  });

  test("folds a multiline fact — including embedded bullets — into one entry", () => {
    const entries = parseBufferEntries(
      "- [Jul 20, 3:15 PM] Migration plan for Alice:\n" +
        "step one is the export\n" +
        "- [ ] follow up on the import\n" +
        "- final touches\n" +
        "- [Jul 20, 3:16 PM] separate fact\n",
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]!.text).toBe(
      "Migration plan for Alice:\nstep one is the export\n- [ ] follow up on the import\n- final touches",
    );
    expect(entries[1]!.text).toBe("separate fact");
  });

  test("keeps interior blank lines inside a multiline fact", () => {
    const entries = parseBufferEntries(
      "- [Jul 20, 3:15 PM] first paragraph\n\nsecond paragraph\n- [Jul 20, 3:16 PM] next\n",
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]!.text).toBe("first paragraph\n\nsecond paragraph");
  });

  test("collects [[slug]] hints from continuation lines too", () => {
    const [entry] = parseBufferEntries(
      "- [Jul 20, 3:15 PM] Update the plan\nsee [[people/alice]]\n",
    );
    expect(entry!.slugs).toEqual(["people/alice"]);
  });

  test("extracts [[slug]] hints, deduped, tolerating |label form", () => {
    const [entry] = parseBufferEntries(
      "- [Jul 20, 3:15 PM] Correction on [[people/alice]] and [[tools/vs-code|VS Code]], see [[people/alice]]\n",
    );
    expect(entry!.slugs).toEqual(["people/alice", "tools/vs-code"]);
  });

  test("ids are content-stable and duplicates get a suffix", () => {
    const first = parseBufferEntries("- [Jul 20, 3:15 PM] same fact\n");
    const again = parseBufferEntries(
      "- [Jul 20, 3:15 PM] same fact\n- [Jul 20, 3:16 PM] other\n- [Jul 20, 3:17 PM] same fact\n",
    );
    // Same text → same id even after unrelated appends…
    expect(again[0]!.id).toBe(first[0]!.id);
    // …and an exact duplicate entry gets a distinct suffixed id.
    expect(again[2]!.id).toBe(`${first[0]!.id}-2`);
  });

  test("empty content yields no entries", () => {
    expect(parseBufferEntries("")).toEqual([]);
    expect(parseBufferEntries("\n\n")).toEqual([]);
  });
});

describe("buildPendingGraph", () => {
  test("maps entries to pending nodes with full text as summary", () => {
    const { nodes, edges } = buildPendingGraph(
      parseBufferEntries("- [Jul 20, 3:15 PM] Alice prefers VS Code\n"),
      new Set(),
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.kind).toBe(PENDING_KIND);
    expect(nodes[0]!.label).toBe("Alice prefers VS Code");
    expect(nodes[0]!.summary).toBe("Alice prefers VS Code");
    expect(edges).toHaveLength(0);
  });

  test("edges only to hinted slugs that exist; weight reflects them", () => {
    const { nodes, edges } = buildPendingGraph(
      parseBufferEntries(
        "- [Jul 20, 3:15 PM] Update [[people/alice]] and [[missing/page]]\n",
      ),
      new Set(["people/alice"]),
    );
    expect(edges).toEqual([
      {
        source: nodes[0]!.id,
        target: "people/alice",
        kind: PENDING_KIND,
        directed: true,
      },
    ]);
    expect(nodes[0]!.weight).toBe(1);
  });

  test("labels a multiline fact by its first line, with the full text as summary", () => {
    const { nodes } = buildPendingGraph(
      parseBufferEntries("- [Jul 20, 3:15 PM] Headline fact\nwith detail\n"),
      new Set(),
    );
    expect(nodes[0]!.label).toBe("Headline fact");
    expect(nodes[0]!.summary).toBe("Headline fact\nwith detail");
  });

  test("labels collapse wikilink markup and truncate long facts", () => {
    const longTail = "x".repeat(80);
    const { nodes } = buildPendingGraph(
      parseBufferEntries(
        `- [Jul 20, 3:15 PM] Likes [[tools/vs-code]]\n- [Jul 20, 3:16 PM] ${longTail}\n`,
      ),
      new Set(),
    );
    expect(nodes[0]!.label).toBe("Likes vs-code");
    expect(nodes[1]!.label!.length).toBeLessThanOrEqual(60);
    expect(nodes[1]!.label!.endsWith("…")).toBe(true);
  });

  test("caps at 200 pending nodes, keeping the newest (tail) entries", () => {
    const content = Array.from(
      { length: 250 },
      (_, i) => `- [Jul 20, 3:15 PM] fact number ${i}`,
    ).join("\n");
    const { nodes } = buildPendingGraph(parseBufferEntries(content), new Set());
    expect(nodes).toHaveLength(200);
    expect(nodes[0]!.label).toBe("fact number 50");
    expect(nodes[199]!.label).toBe("fact number 249");
  });
});
