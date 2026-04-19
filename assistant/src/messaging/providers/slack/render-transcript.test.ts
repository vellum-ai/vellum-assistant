/**
 * Unit tests for the pure chronological Slack transcript renderer.
 *
 * Covers tag variants (top-level, reply, edit, delete, reaction add/remove),
 * stable parent aliases, reaction cap, sort stability under identical ts,
 * the four scenarios from the design brief, and mixed legacy/post-upgrade
 * fixtures.
 */

import { describe, expect, test } from "bun:test";

import {
  parentAlias,
  type RenderableSlackMessage,
  renderSlackTranscript,
} from "./render-transcript.js";

// ── helpers ──────────────────────────────────────────────────────────────────

// Anchor times: 14:25:00 UTC on 2023-11-14 = 1699971900 (Slack ts seconds).
// We work entirely in UTC because the renderer formats UTC HH:MM.
const TS_14_25 = "1699971900.000100"; // 14:25 UTC
const TS_14_26 = "1699971960.000200"; // 14:26 UTC
const TS_14_28 = "1699972080.000300"; // 14:28 UTC
const TS_14_30 = "1699972200.000400"; // 14:30 UTC

const MS_14_25 = 1699971900_000;
const MS_14_30 = 1699972200_000;
const MS_14_32 = 1699972320_000;

const CHANNEL = "C0001";

function userMsg(
  ts: string,
  sender: string,
  content: string,
  opts: {
    threadTs?: string;
    editedAt?: number;
    deletedAt?: number;
    role?: "user" | "assistant";
    createdAt?: number;
  } = {},
): RenderableSlackMessage {
  return {
    role: opts.role ?? "user",
    content,
    senderLabel: sender,
    createdAt: opts.createdAt ?? Number.parseFloat(ts) * 1000,
    metadata: {
      source: "slack",
      channelId: CHANNEL,
      channelTs: ts,
      threadTs: opts.threadTs,
      eventKind: "message",
      editedAt: opts.editedAt,
      deletedAt: opts.deletedAt,
    },
  };
}

function reactionMsg(
  ts: string,
  actor: string,
  emoji: string,
  targetTs: string,
  op: "added" | "removed" = "added",
  role: "user" | "assistant" = "user",
): RenderableSlackMessage {
  return {
    role,
    content: "",
    senderLabel: actor,
    createdAt: Number.parseFloat(ts) * 1000,
    metadata: {
      source: "slack",
      channelId: CHANNEL,
      channelTs: ts,
      eventKind: "reaction",
      reaction: {
        emoji,
        targetChannelTs: targetTs,
        op,
      },
    },
  };
}

function legacyMsg(
  createdAt: number,
  sender: string,
  content: string,
  role: "user" | "assistant" = "user",
): RenderableSlackMessage {
  return { role, content, senderLabel: sender, createdAt, metadata: null };
}

// ── basics ───────────────────────────────────────────────────────────────────

describe("renderSlackTranscript — basics", () => {
  test("empty array yields empty array", () => {
    expect(renderSlackTranscript([])).toEqual([]);
  });

  test("renders top-level message with HH:MM tag", () => {
    const out = renderSlackTranscript([userMsg(TS_14_25, "@alice", "hi")]);
    expect(out).toEqual([{ role: "user", content: "[14:25 @alice]: hi" }]);
  });

  test("renders thread reply with parent alias arrow", () => {
    const out = renderSlackTranscript([
      userMsg(TS_14_28, "@bob", "got it", { threadTs: TS_14_25 }),
    ]);
    const alias = parentAlias(TS_14_25);
    expect(out).toEqual([
      { role: "user", content: `[14:28 @bob → ${alias}]: got it` },
    ]);
  });

  test("renders edited message with editedAt suffix", () => {
    const out = renderSlackTranscript([
      userMsg(TS_14_25, "@alice", "hi (revised)", { editedAt: MS_14_30 }),
    ]);
    expect(out).toEqual([
      {
        role: "user",
        content: "[14:25 @alice, edited 14:30]: hi (revised)",
      },
    ]);
  });

  test("renders deleted message with deletedAt — content elided", () => {
    const out = renderSlackTranscript([
      userMsg(TS_14_25, "@alice", "(removed)", { deletedAt: MS_14_32 }),
    ]);
    expect(out).toEqual([
      { role: "user", content: "[14:25 @alice — deleted 14:32]" },
    ]);
  });

  test("renders reaction added", () => {
    const alias = parentAlias(TS_14_25);
    const out = renderSlackTranscript([
      reactionMsg(TS_14_28, "@bob", "👍", TS_14_25, "added"),
    ]);
    expect(out).toEqual([
      { role: "user", content: `[14:28 @bob reacted 👍 to ${alias}]` },
    ]);
  });

  test("renders reaction removed", () => {
    const alias = parentAlias(TS_14_25);
    const out = renderSlackTranscript([
      reactionMsg(TS_14_28, "@bob", "👍", TS_14_25, "removed"),
    ]);
    expect(out).toEqual([
      { role: "user", content: `[14:28 @bob removed 👍 from ${alias}]` },
    ]);
  });
});

// ── parent alias stability ───────────────────────────────────────────────────

describe("parentAlias", () => {
  test("is stable across calls with the same ts", () => {
    const a = parentAlias("1700000000.000100");
    const b = parentAlias("1700000000.000100");
    expect(a).toEqual(b);
  });

  test("differs across distinct ts values", () => {
    const a = parentAlias("1700000000.000100");
    const b = parentAlias("1700000000.000200");
    expect(a).not.toEqual(b);
  });

  test("starts with M and is 7 chars long (M + 6 hex)", () => {
    const a = parentAlias("1700000000.000100");
    expect(a).toMatch(/^M[0-9a-f]{6}$/);
  });
});

// ── reaction cap ─────────────────────────────────────────────────────────────

describe("renderSlackTranscript — reaction cap", () => {
  test("renders all reactions when below the default cap (5)", () => {
    const messages: RenderableSlackMessage[] = [
      userMsg(TS_14_25, "@alice", "hi"),
      reactionMsg("1700000800.000001", "@u1", "👍", TS_14_25),
      reactionMsg("1700000800.000002", "@u2", "🎉", TS_14_25),
      reactionMsg("1700000800.000003", "@u3", "🔥", TS_14_25),
    ];
    const out = renderSlackTranscript(messages);
    expect(out.length).toBe(4);
    expect(out.some((r) => r.content.includes("more reactions"))).toBe(false);
  });

  test("collapses excess reactions into a trailer line", () => {
    const messages: RenderableSlackMessage[] = [
      userMsg(TS_14_25, "@alice", "hi"),
      reactionMsg("1700000800.000001", "@u1", "👍", TS_14_25),
      reactionMsg("1700000800.000002", "@u2", "🎉", TS_14_25),
      reactionMsg("1700000800.000003", "@u3", "🔥", TS_14_25),
      reactionMsg("1700000800.000004", "@u4", "💯", TS_14_25),
      reactionMsg("1700000800.000005", "@u5", "👏", TS_14_25),
      reactionMsg("1700000800.000006", "@u6", "👀", TS_14_25),
      reactionMsg("1700000800.000007", "@u7", "🚀", TS_14_25),
    ];
    const out = renderSlackTranscript(messages);
    // 1 message + 5 rendered reactions + 1 trailer.
    expect(out.length).toBe(7);
    const trailer = out[out.length - 1];
    expect(trailer.content).toMatch(/…and 2 more reactions to M[0-9a-f]{6}\]/);
  });

  test("respects custom maxReactionsPerMessage", () => {
    const messages: RenderableSlackMessage[] = [
      userMsg(TS_14_25, "@alice", "hi"),
      reactionMsg("1700000800.000001", "@u1", "👍", TS_14_25),
      reactionMsg("1700000800.000002", "@u2", "🎉", TS_14_25),
      reactionMsg("1700000800.000003", "@u3", "🔥", TS_14_25),
    ];
    const out = renderSlackTranscript(messages, { maxReactionsPerMessage: 2 });
    // 1 msg + 2 reactions + 1 trailer for 1 excess.
    expect(out.length).toBe(4);
    expect(out[out.length - 1].content).toMatch(
      /…and 1 more reactions to M[0-9a-f]{6}\]/,
    );
  });

  test("caps are tracked per-target message independently", () => {
    const messages: RenderableSlackMessage[] = [
      userMsg(TS_14_25, "@alice", "first"),
      userMsg(TS_14_26, "@alice", "second"),
      // 2 reactions on first
      reactionMsg("1700000800.000001", "@u1", "👍", TS_14_25),
      reactionMsg("1700000800.000002", "@u2", "🎉", TS_14_25),
      // 2 reactions on second
      reactionMsg("1700000800.000003", "@u3", "🔥", TS_14_26),
      reactionMsg("1700000800.000004", "@u4", "💯", TS_14_26),
    ];
    const out = renderSlackTranscript(messages, { maxReactionsPerMessage: 5 });
    // 2 messages + 4 reactions, no trailers.
    expect(out.length).toBe(6);
    expect(out.some((r) => r.content.includes("more reactions"))).toBe(false);
  });
});

// ── sort stability ───────────────────────────────────────────────────────────

describe("renderSlackTranscript — sort", () => {
  test("orders chronologically by channelTs", () => {
    const out = renderSlackTranscript([
      userMsg(TS_14_30, "@late", "later"),
      userMsg(TS_14_25, "@early", "earlier"),
      userMsg(TS_14_28, "@mid", "middle"),
    ]);
    expect(out.map((r) => r.content)).toEqual([
      "[14:25 @early]: earlier",
      "[14:28 @mid]: middle",
      "[14:30 @late]: later",
    ]);
  });

  test("preserves input order when sort keys are identical (stable sort)", () => {
    const sameTs = TS_14_25;
    const out = renderSlackTranscript([
      userMsg(sameTs, "@first", "1"),
      userMsg(sameTs, "@second", "2"),
      userMsg(sameTs, "@third", "3"),
    ]);
    expect(out.map((r) => r.content)).toEqual([
      "[14:25 @first]: 1",
      "[14:25 @second]: 2",
      "[14:25 @third]: 3",
    ]);
  });
});

// ── design brief scenarios ───────────────────────────────────────────────────

describe("renderSlackTranscript — four design-brief scenarios", () => {
  // Setup: a top-level @alice message at 14:25; a sibling @carol top-level
  // at 14:28; two replies in @alice's thread.
  const aliceTopTs = TS_14_25;
  const carolTopTs = TS_14_28;
  const bobReply1Ts = "1699971960.000300"; // 14:26
  const aliceReply2Ts = "1699972020.000400"; // 14:27

  function baseFixture(): RenderableSlackMessage[] {
    return [
      userMsg(aliceTopTs, "@alice", "lunch?"),
      userMsg(bobReply1Ts, "@bob", "yes!", { threadTs: aliceTopTs }),
      userMsg(aliceReply2Ts, "@alice", "12:30 ok?", { threadTs: aliceTopTs }),
      userMsg(carolTopTs, "@carol", "standup soon"),
    ];
  }

  test("scenario: reply in an existing thread", () => {
    const replyTs = "1699972100.000500"; // 14:28:20 — after carol's top
    const messages = [
      ...baseFixture(),
      userMsg(replyTs, "@dan", "I'll join", { threadTs: aliceTopTs }),
    ];
    const out = renderSlackTranscript(messages);
    const aliceAlias = parentAlias(aliceTopTs);
    expect(out.map((r) => r.content)).toEqual([
      "[14:25 @alice]: lunch?",
      `[14:26 @bob → ${aliceAlias}]: yes!`,
      `[14:27 @alice → ${aliceAlias}]: 12:30 ok?`,
      "[14:28 @carol]: standup soon",
      `[14:28 @dan → ${aliceAlias}]: I'll join`,
    ]);
  });

  test("scenario: reply to a top-level message (creating a new thread)", () => {
    // @ed replies to @carol's top-level message; carol's top becomes a thread.
    const replyTs = "1699972100.000600"; // 14:28:20
    const messages = [
      ...baseFixture(),
      userMsg(replyTs, "@ed", "joining now", { threadTs: carolTopTs }),
    ];
    const out = renderSlackTranscript(messages);
    const carolAlias = parentAlias(carolTopTs);
    // The reply tag points at carol's alias; carol's top stays untagged.
    expect(out[out.length - 1].content).toBe(
      `[14:28 @ed → ${carolAlias}]: joining now`,
    );
    expect(out[3].content).toBe("[14:28 @carol]: standup soon");
  });

  test("scenario: reply to the most recent top-level message", () => {
    // Same as above but emphasises the "last message" case.
    const replyTs = "1699972110.000700"; // 14:28:30
    const messages = [
      ...baseFixture(),
      userMsg(replyTs, "@frank", "+1", { threadTs: carolTopTs }),
    ];
    const out = renderSlackTranscript(messages);
    const carolAlias = parentAlias(carolTopTs);
    expect(out[out.length - 1].content).toBe(
      `[14:28 @frank → ${carolAlias}]: +1`,
    );
  });

  test("scenario: new top-level message (no threadTs)", () => {
    const messages = [
      ...baseFixture(),
      userMsg("1699972260.000800", "@gina", "anyone in office?"), // 14:31
    ];
    const out = renderSlackTranscript(messages);
    // No arrow on the new top-level row.
    expect(out[out.length - 1].content).toBe(
      "[14:31 @gina]: anyone in office?",
    );
  });
});

// ── mixed legacy + post-upgrade fixture ──────────────────────────────────────

describe("renderSlackTranscript — mixed legacy + post-upgrade", () => {
  test("legacy rows render flat with no thread tag and intermix chronologically", () => {
    const messages: RenderableSlackMessage[] = [
      // Post-upgrade: 14:28 reply in alice's thread
      userMsg("1699972080.000900", "@bob", "yes!", { threadTs: TS_14_25 }),
      // Legacy row at 14:26 — should sort BETWEEN the 14:25 post-upgrade
      // top-level and the 14:28 post-upgrade reply.
      legacyMsg(1699971960_000, "@dana", "drive-by note"),
      // Post-upgrade: 14:25 alice top-level
      userMsg(TS_14_25, "@alice", "lunch?"),
    ];
    const out = renderSlackTranscript(messages);
    const alias = parentAlias(TS_14_25);

    expect(out.map((r) => r.content)).toEqual([
      "[14:25 @alice]: lunch?",
      "[14:26 @dana]: drive-by note",
      `[14:28 @bob → ${alias}]: yes!`,
    ]);
    // Ensure the legacy row has no arrow.
    expect(out[1].content.includes("→")).toBe(false);
  });

  test("legacy assistant row carries assistant role", () => {
    const out = renderSlackTranscript([
      legacyMsg(MS_14_25, "@bot", "ack", "assistant"),
    ]);
    expect(out).toEqual([
      { role: "assistant", content: "[14:25 @bot]: ack" },
    ]);
  });

  test("preserves message role faithfully across mixed inputs", () => {
    const out = renderSlackTranscript([
      userMsg(TS_14_25, "@alice", "q?"),
      userMsg(TS_14_26, "@bot", "a", { role: "assistant" }),
      legacyMsg(MS_14_30, "@bot", "later legacy", "assistant"),
    ]);
    expect(out.map((r) => r.role)).toEqual(["user", "assistant", "assistant"]);
  });
});

// ── purity ────────────────────────────────────────────────────────────────────

describe("renderSlackTranscript — purity", () => {
  test("does not mutate the input array or its elements", () => {
    const original: RenderableSlackMessage[] = [
      userMsg(TS_14_30, "@late", "later"),
      userMsg(TS_14_25, "@early", "earlier"),
    ];
    const snapshot = original.map((m) => ({ ...m, metadata: m.metadata }));
    renderSlackTranscript(original);
    expect(original.length).toBe(snapshot.length);
    for (let i = 0; i < original.length; i++) {
      expect(original[i].content).toBe(snapshot[i].content);
      expect(original[i].senderLabel).toBe(snapshot[i].senderLabel);
      expect(original[i].metadata).toBe(snapshot[i].metadata);
    }
  });

  test("identical inputs produce identical outputs (deterministic)", () => {
    const fixture: RenderableSlackMessage[] = [
      userMsg(TS_14_25, "@alice", "hi"),
      userMsg(TS_14_28, "@bob", "yo", { threadTs: TS_14_25 }),
      reactionMsg(TS_14_30, "@carol", "👍", TS_14_25),
    ];
    const a = renderSlackTranscript(fixture);
    const b = renderSlackTranscript(fixture);
    expect(a).toEqual(b);
  });
});
