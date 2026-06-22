import { describe, expect, test } from "bun:test";

import {
  buildPackets,
  buildRetriever,
  type Corpus,
  dot,
  type EmbedAll,
  mulberry32,
  pairTurns,
  type RawMsgRow,
  renderMemorySet,
  resolveDir,
  selectPinnedTurns,
  turnConversationId,
} from "../eval-packets.js";

/** Build a stored content-block JSON string the way the DB holds it. */
function block(text: string): string {
  return JSON.stringify([{ type: "text", text }]);
}

/** A tiny bag-of-words embedder so dense cosine is meaningful in tests. */
const VOCAB = ["alice", "bob", "laptop", "coffee", "dog", "paris"];
const fakeEmbed: EmbedAll = async (texts) =>
  texts.map((t) => {
    const lower = t.toLowerCase();
    return VOCAB.map(
      (w) => (lower.match(new RegExp(`\\b${w}\\b`, "g")) ?? []).length,
    );
  });

function page(title: string, body: string): { raw: string; body: string } {
  const fullBody = `# ${title}\n\n${body}`;
  return { raw: `---\ntitle: ${title}\n---\n${fullBody}`, body: fullBody };
}

function makeCorpus(): Corpus {
  const slugs = ["alice", "coffee-ritual", "dog"];
  const rawBySlug = new Map<string, string>();
  const bodyBySlug = new Map<string, string>();
  const pages: Record<string, { raw: string; body: string }> = {
    alice: page("Alice", "## laptop\nAlice works on her laptop in Paris."),
    "coffee-ritual": page(
      "Coffee ritual",
      "## morning\nBob makes coffee every morning.",
    ),
    dog: page("Dog", "## rex\nThe dog Rex is a golden retriever."),
  };
  for (const slug of slugs) {
    rawBySlug.set(slug, pages[slug]!.raw);
    bodyBySlug.set(slug, pages[slug]!.body);
  }
  return { slugs, rawBySlug, bodyBySlug };
}

describe("pairTurns", () => {
  const rows: RawMsgRow[] = [
    {
      conversationId: "c1",
      id: "m1",
      role: "user",
      content: block("hello alice"),
      createdAt: 100,
    },
    {
      conversationId: "c1",
      id: "m2",
      role: "assistant",
      content: block("Here is a long enough reply about Alice and her laptop."),
      createdAt: 101,
    },
    {
      conversationId: "c1",
      id: "m3",
      role: "user",
      content: block("and bob?"),
      createdAt: 102,
    },
    {
      conversationId: "c1",
      id: "m4",
      role: "assistant",
      content: block("Bob prefers coffee in the morning, every single day."),
      createdAt: 103,
    },
    {
      conversationId: "c2",
      id: "m5",
      role: "user",
      content: block("dog?"),
      createdAt: 200,
    },
    {
      conversationId: "c2",
      id: "m6",
      role: "assistant",
      content: block("short"),
      createdAt: 201,
    },
    {
      conversationId: "c2",
      id: "m7",
      role: "user",
      content: block("tell me about the dog please"),
      createdAt: 202,
    },
    {
      conversationId: "c2",
      id: "m8",
      role: "assistant",
      content: block(
        "The dog is a golden retriever named Rex who loves walks.",
      ),
      createdAt: 203,
    },
  ];

  test("pairs user→next-assistant, drops short replies, ranks by recency", () => {
    const turns = pairTurns(rows, { limit: 10, perConversationCap: 10 });
    expect(turns.map((t) => t.turn)).toEqual(["c2:202", "c1:102", "c1:100"]);
    // m5/m6 dropped: the reply "short" is under the 40-char floor.
    expect(turns.find((t) => t.turn === "c2:202")?.userText).toBe(
      "tell me about the dog please",
    );
    expect(turns.find((t) => t.turn === "c2:202")?.replyText).toContain(
      "golden retriever",
    );
  });

  test("context carries the previous reply in the same conversation", () => {
    const turns = pairTurns(rows, { limit: 10, perConversationCap: 10 });
    expect(turns.find((t) => t.turn === "c1:100")?.context).toBe(""); // first turn, no prior reply
    expect(turns.find((t) => t.turn === "c1:102")?.context).toContain(
      "Alice and her laptop",
    );
  });

  test("per-conversation cap keeps the most recent within each conversation", () => {
    const turns = pairTurns(rows, { limit: 10, perConversationCap: 1 });
    expect(turns.map((t) => t.turn).sort()).toEqual(["c1:102", "c2:202"]);
  });
});

describe("buildRetriever + retrieve", () => {
  test("needle-only retrieves the lexically relevant page", async () => {
    const retriever = await buildRetriever(makeCorpus(), fakeEmbed, false);
    const hits = retriever.retrieve("alice laptop paris", null, 3);
    expect(hits[0]?.slug).toBe("alice");
  });

  test("dense lane retrieves by embedding similarity", async () => {
    const retriever = await buildRetriever(makeCorpus(), fakeEmbed, true);
    const [queryVec] = await fakeEmbed(["coffee"]);
    const hits = retriever.retrieve("coffee", queryVec!, 3);
    expect(hits.map((h) => h.slug)).toContain("coffee-ritual");
  });
});

describe("renderMemorySet", () => {
  test("renders cards + matched sections, and a sentinel for empty", async () => {
    const retriever = await buildRetriever(makeCorpus(), fakeEmbed, false);
    const hits = retriever.retrieve("alice laptop", null, 2);
    const set = renderMemorySet(retriever, hits, 1200);
    expect(set).toContain("memory/concepts/alice.md");
    expect(set).toContain("Alice works on her laptop");
    expect(renderMemorySet(retriever, [], 1200)).toBe("(no pages retrieved)");
  });
});

describe("buildPackets", () => {
  const turns = [
    {
      turn: "c1:100",
      conversationId: "c1",
      userText: "alice laptop",
      replyText: "reply one",
      context: "",
      createdAt: 100,
    },
    {
      turn: "c2:200",
      conversationId: "c2",
      userText: "coffee",
      replyText: "reply two",
      context: "",
      createdAt: 200,
    },
  ];

  test("produces one blinded packet per turn with a consistent, reproducible key", async () => {
    const snapshot = await buildRetriever(makeCorpus(), fakeEmbed, false);
    const staging = await buildRetriever(makeCorpus(), fakeEmbed, false);
    const opts = { dense: false, seed: 42, k: 4, sectionCharCap: 1200 };

    const { packets, key } = await buildPackets(
      turns,
      snapshot,
      staging,
      fakeEmbed,
      opts,
    );
    expect(packets).toHaveLength(2);
    expect(key).toHaveLength(2);
    for (let i = 0; i < packets.length; i++) {
      expect(packets[i]!.turn).toBe(turns[i]!.turn);
      expect(packets[i]!.userMessage).toBe(turns[i]!.userText);
      expect(packets[i]!.reply).toBe(turns[i]!.replyText);
      expect(packets[i]!.setA.length).toBeGreaterThan(0);
      expect(packets[i]!.setB.length).toBeGreaterThan(0);
      // a/b are the two corpora, never the same side twice.
      expect(new Set([key[i]!.a, key[i]!.b])).toEqual(
        new Set(["snapshot", "staging"]),
      );
    }

    // Same seed → identical blinding assignment.
    const rerun = await buildPackets(turns, snapshot, staging, fakeEmbed, opts);
    expect(rerun.key).toEqual(key);
  });
});

describe("primitives", () => {
  test("dot is cosine on unit vectors", () => {
    expect(dot([1, 0], [1, 0])).toBeCloseTo(1);
    expect(dot([1, 0], [0, 1])).toBeCloseTo(0);
  });

  test("mulberry32 is deterministic for a seed", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("resolveDir", () => {
  test("resolves a relative path under the workspace", () => {
    expect(resolveDir("/ws", ".mv3/staging")).toBe("/ws/.mv3/staging");
  });
  test("rejects an absolute path outside the workspace", () => {
    expect(() => resolveDir("/ws", "/etc/passwd")).toThrow(
      /within the workspace/,
    );
  });
  test("rejects a relative path that escapes the workspace", () => {
    expect(() => resolveDir("/ws", "../outside")).toThrow(
      /within the workspace/,
    );
  });
});

describe("turn pinning (reproducible re-runs)", () => {
  const mk = (turn: string, createdAt: number) => ({
    turn,
    conversationId: turnConversationId(turn),
    userText: `u-${turn}`,
    replyText: `r-${turn}`,
    context: "",
    createdAt,
  });
  const all = [mk("c1:100", 100), mk("c1:102", 102), mk("c2:200", 200)];

  test("turnConversationId splits on the LAST colon (ids keep colons)", () => {
    expect(turnConversationId("c1:100")).toBe("c1");
    // A UUID conversation id has no colons; the createdAt is the final segment.
    expect(turnConversationId("019d1e04-cb20-719a:1781916529975")).toBe(
      "019d1e04-cb20-719a",
    );
  });

  test("keeps exactly the pinned turns, in pinned order", () => {
    const picked = selectPinnedTurns(all, ["c2:200", "c1:100"]);
    expect(picked.map((t) => t.turn)).toEqual(["c2:200", "c1:100"]);
  });

  test("drops pinned ids that no longer exist (count surfaces the loss)", () => {
    const picked = selectPinnedTurns(all, ["c1:100", "c9:999", "c1:102"]);
    // c9:999 was deleted since the ids were captured — dropped, not faked.
    expect(picked.map((t) => t.turn)).toEqual(["c1:100", "c1:102"]);
    expect(picked).toHaveLength(2);
  });

  test("an empty pin set selects nothing", () => {
    expect(selectPinnedTurns(all, [])).toEqual([]);
  });
});
