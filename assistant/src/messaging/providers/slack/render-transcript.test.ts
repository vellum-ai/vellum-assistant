/**
 * Unit tests for the pure chronological Slack transcript renderer.
 *
 * Covers tag variants (top-level, reply, edit, delete, reaction add/remove),
 * stable parent aliases, reaction cap, sort stability under identical ts,
 * the four scenarios from the design brief, and mixed legacy/post-upgrade
 * fixtures.
 */

import { describe, expect, test } from "bun:test";

import type { Message } from "../../../providers/types.js";
import {
  extractTagLineTexts,
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

/** Build an expected `Message` fixture with a single text content block. */
function textMsg(role: "user" | "assistant", text: string): Message {
  return { role, content: [{ type: "text", text }] };
}

// ── basics ───────────────────────────────────────────────────────────────────

describe("renderSlackTranscript — basics", () => {
  test("empty array yields empty array", () => {
    expect(renderSlackTranscript([])).toEqual([]);
  });

  test("renders top-level message with HH:MM tag", () => {
    const out = renderSlackTranscript([userMsg(TS_14_25, "@alice", "hi")]);
    expect(out).toEqual([textMsg("user", "[14:25 @alice]: hi")]);
  });

  test("renders thread reply with parent alias arrow", () => {
    const out = renderSlackTranscript([
      userMsg(TS_14_28, "@bob", "got it", { threadTs: TS_14_25 }),
    ]);
    const alias = parentAlias(TS_14_25);
    expect(out).toEqual([
      textMsg("user", `[14:28 @bob → ${alias}]: got it`),
    ]);
  });

  test("renders edited message with editedAt suffix", () => {
    const out = renderSlackTranscript([
      userMsg(TS_14_25, "@alice", "hi (revised)", { editedAt: MS_14_30 }),
    ]);
    expect(out).toEqual([
      textMsg("user", "[14:25 @alice, edited 14:30]: hi (revised)"),
    ]);
  });

  test("edited marker uses editedAt time, not channelTs", () => {
    // channelTs at 14:25 (original send time), edited later at 14:32.
    // The opening time bracket must reflect 14:25 and the suffix must
    // reflect 14:32 — derived from editedAt, not from channelTs.
    const out = renderSlackTranscript([
      userMsg(TS_14_25, "@alice", "v2", { editedAt: MS_14_32 }),
    ]);
    expect(out).toEqual([textMsg("user", "[14:25 @alice, edited 14:32]: v2")]);
  });

  test("edited message in a thread renders both arrow and edit suffix", () => {
    const out = renderSlackTranscript([
      userMsg(TS_14_28, "@bob", "got it (edit)", {
        threadTs: TS_14_25,
        editedAt: MS_14_30,
      }),
    ]);
    const alias = parentAlias(TS_14_25);
    expect(out).toEqual([
      textMsg("user", `[14:28 @bob → ${alias}, edited 14:30]: got it (edit)`),
    ]);
  });

  test("renders deleted message with deletedAt — content elided", () => {
    const out = renderSlackTranscript([
      userMsg(TS_14_25, "@alice", "(removed)", { deletedAt: MS_14_32 }),
    ]);
    expect(out).toEqual([
      textMsg("user", "[14:25 @alice — deleted 14:32]"),
    ]);
  });

  test("delete takes precedence over edit (delete wins)", () => {
    // A message that was edited at 14:30 and then deleted at 14:32
    // should render as deleted, not edited — and content must be elided.
    const out = renderSlackTranscript([
      userMsg(TS_14_25, "@alice", "edited body", {
        editedAt: MS_14_30,
        deletedAt: MS_14_32,
      }),
    ]);
    expect(out).toEqual([
      textMsg("user", "[14:25 @alice — deleted 14:32]"),
    ]);
    const text0 = extractTagLineTexts(out)[0];
    // No "edited" suffix should leak through.
    expect(text0.includes("edited")).toBe(false);
    // Content body must not appear.
    expect(text0.includes("edited body")).toBe(false);
  });

  test("deleted message preserves chronological ordering", () => {
    // A deleted message in the middle of a transcript should still occupy
    // its chronological slot — only the body is elided.
    const out = renderSlackTranscript([
      userMsg(TS_14_25, "@alice", "first"),
      userMsg(TS_14_28, "@bob", "(removed)", { deletedAt: MS_14_30 }),
      userMsg(TS_14_30, "@carol", "third"),
    ]);
    expect(extractTagLineTexts(out)).toEqual([
      "[14:25 @alice]: first",
      "[14:28 @bob — deleted 14:30]",
      "[14:30 @carol]: third",
    ]);
  });

  test("renders reaction added", () => {
    const alias = parentAlias(TS_14_25);
    const out = renderSlackTranscript([
      reactionMsg(TS_14_28, "@bob", "👍", TS_14_25, "added"),
    ]);
    expect(out).toEqual([
      textMsg("user", `[14:28 @bob reacted 👍 to ${alias}]`),
    ]);
  });

  test("renders reaction removed", () => {
    const alias = parentAlias(TS_14_25);
    const out = renderSlackTranscript([
      reactionMsg(TS_14_28, "@bob", "👍", TS_14_25, "removed"),
    ]);
    expect(out).toEqual([
      textMsg("user", `[14:28 @bob removed 👍 from ${alias}]`),
    ]);
  });
});

// ── edited marker ────────────────────────────────────────────────────────────

describe("renderSlackTranscript — edited marker", () => {
  test("deleted takes precedence over edited (no edit suffix on deleted line)", () => {
    // A row may carry both editedAt and deletedAt if it was edited before
    // being deleted. The deleted form takes precedence and the edited
    // suffix must not appear.
    const out = renderSlackTranscript([
      userMsg(TS_14_25, "@alice", "(removed)", {
        editedAt: MS_14_30,
        deletedAt: MS_14_32,
      }),
    ]);
    expect(out).toEqual([
      textMsg("user", "[14:25 @alice — deleted 14:32]"),
    ]);
    expect(extractTagLineTexts(out)[0].includes("edited")).toBe(false);
  });

  test("reaction rows do not render the edited marker even if metadata has editedAt", () => {
    // The renderer must never apply the edited suffix to a reaction-kind row.
    // We construct a reaction with an editedAt field set in metadata to
    // confirm the reaction code path ignores it.
    const reaction: RenderableSlackMessage = {
      role: "user",
      content: "",
      senderLabel: "@bob",
      createdAt: Number.parseFloat(TS_14_28) * 1000,
      metadata: {
        source: "slack",
        channelId: CHANNEL,
        channelTs: TS_14_28,
        eventKind: "reaction",
        reaction: {
          emoji: "👍",
          targetChannelTs: TS_14_25,
          op: "added",
        },
        editedAt: MS_14_30,
      },
    };
    const out = renderSlackTranscript([reaction]);
    const alias = parentAlias(TS_14_25);
    expect(out).toEqual([
      textMsg("user", `[14:28 @bob reacted 👍 to ${alias}]`),
    ]);
    expect(extractTagLineTexts(out)[0].includes("edited")).toBe(false);
  });

  test("editedAt of 0 (epoch) still renders as 00:00 marker", () => {
    // Defensive: 0 is a valid (if unusual) timestamp and must not be
    // skipped by a truthy check.
    const out = renderSlackTranscript([
      userMsg(TS_14_25, "@alice", "v2", { editedAt: 0 }),
    ]);
    expect(out).toEqual([
      textMsg("user", "[14:25 @alice, edited 00:00]: v2"),
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
    expect(
      extractTagLineTexts(out).some((t) => t.includes("more reactions")),
    ).toBe(false);
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
    const trailer = extractTagLineTexts(out)[out.length - 1];
    expect(trailer).toMatch(/…and 2 more reactions to M[0-9a-f]{6}\]/);
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
    expect(extractTagLineTexts(out)[out.length - 1]).toMatch(
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
    expect(
      extractTagLineTexts(out).some((t) => t.includes("more reactions")),
    ).toBe(false);
  });
});

// ── mixed message + reaction chronology ─────────────────────────────────────

describe("renderSlackTranscript — mixed message + reaction chronology", () => {
  test("reaction renders inline at correct chronological position", () => {
    // Order of events as they happened in time:
    //   14:25 — alice posts the parent
    //   14:26 — bob posts a follow-up message
    //   14:28 — carol reacts to alice's parent
    //   14:30 — dan posts another message
    // Inputs are intentionally shuffled so the renderer must sort.
    const aliasParent = parentAlias(TS_14_25);
    const out = renderSlackTranscript([
      reactionMsg(TS_14_28, "@carol", "👍", TS_14_25, "added"),
      userMsg(TS_14_30, "@dan", "later"),
      userMsg(TS_14_25, "@alice", "lunch?"),
      userMsg(TS_14_26, "@bob", "yes"),
    ]);
    expect(extractTagLineTexts(out)).toEqual([
      "[14:25 @alice]: lunch?",
      "[14:26 @bob]: yes",
      `[14:28 @carol reacted 👍 to ${aliasParent}]`,
      "[14:30 @dan]: later",
    ]);
  });

  test("removed reactions interleave with messages by their own ts", () => {
    // A reaction is added at 14:26 then removed at 14:30; bob posts a message
    // at 14:28 in between. The "removed" line must land between bob's message
    // and dan's later message, not collapsed beside the "added" line.
    const aliasParent = parentAlias(TS_14_25);
    const out = renderSlackTranscript([
      userMsg(TS_14_25, "@alice", "lunch?"),
      reactionMsg("1699971960.000010", "@carol", "👍", TS_14_25, "added"),
      userMsg(TS_14_28, "@bob", "yes"),
      reactionMsg(TS_14_30, "@carol", "👍", TS_14_25, "removed"),
    ]);
    expect(extractTagLineTexts(out)).toEqual([
      "[14:25 @alice]: lunch?",
      `[14:26 @carol reacted 👍 to ${aliasParent}]`,
      "[14:28 @bob]: yes",
      `[14:30 @carol removed 👍 from ${aliasParent}]`,
    ]);
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
    expect(extractTagLineTexts(out)).toEqual([
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
    expect(extractTagLineTexts(out)).toEqual([
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
    expect(extractTagLineTexts(out)).toEqual([
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
    const texts = extractTagLineTexts(out);
    // The reply tag points at carol's alias; carol's top stays untagged.
    expect(texts[texts.length - 1]).toBe(
      `[14:28 @ed → ${carolAlias}]: joining now`,
    );
    expect(texts[3]).toBe("[14:28 @carol]: standup soon");
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
    const texts = extractTagLineTexts(out);
    expect(texts[texts.length - 1]).toBe(`[14:28 @frank → ${carolAlias}]: +1`);
  });

  test("scenario: new top-level message (no threadTs)", () => {
    const messages = [
      ...baseFixture(),
      userMsg("1699972260.000800", "@gina", "anyone in office?"), // 14:31
    ];
    const out = renderSlackTranscript(messages);
    const texts = extractTagLineTexts(out);
    // No arrow on the new top-level row.
    expect(texts[texts.length - 1]).toBe("[14:31 @gina]: anyone in office?");
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

    const texts = extractTagLineTexts(out);
    expect(texts).toEqual([
      "[14:25 @alice]: lunch?",
      "[14:26 @dana]: drive-by note",
      `[14:28 @bob → ${alias}]: yes!`,
    ]);
    // Ensure the legacy row has no arrow.
    expect(texts[1].includes("→")).toBe(false);
  });

  test("legacy assistant row carries assistant role", () => {
    const out = renderSlackTranscript([
      legacyMsg(MS_14_25, "@bot", "ack", "assistant"),
    ]);
    expect(out).toEqual([textMsg("assistant", "[14:25 @bot]: ack")]);
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

// ── shape: Message[] / content-block structure ───────────────────────────────

describe("renderSlackTranscript — Message[] shape", () => {
  test("empty input returns an empty array", () => {
    expect(renderSlackTranscript([])).toEqual([]);
  });

  test("single text message returns one Message with one text content block", () => {
    const out = renderSlackTranscript([userMsg(TS_14_25, "@alice", "hi")]);
    expect(out).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "[14:25 @alice]: hi" }],
      },
    ]);
  });

  test("stable sort: messages with identical channelTs preserve input order", () => {
    const sameTs = TS_14_25;
    const out = renderSlackTranscript([
      userMsg(sameTs, "@first", "1"),
      userMsg(sameTs, "@second", "2"),
    ]);
    expect(out).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "[14:25 @first]: 1" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "[14:25 @second]: 2" }],
      },
    ]);
  });
});

// ── extractTagLineTexts helper ───────────────────────────────────────────────

describe("extractTagLineTexts", () => {
  test("returns first text block text per message", () => {
    const rendered: Message[] = [
      { role: "user", content: [{ type: "text", text: "line-a" }] },
      { role: "assistant", content: [{ type: "text", text: "line-b" }] },
    ];
    expect(extractTagLineTexts(rendered)).toEqual(["line-a", "line-b"]);
  });

  test("returns empty string for a message with no text block", () => {
    const rendered: Message[] = [
      { role: "user", content: [{ type: "text", text: "only text" }] },
      // A message whose content has no text block at all (e.g. solely a
      // tool_use/tool_result). The helper must emit "" rather than throw.
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "noop",
            input: {},
          },
        ],
      },
    ];
    expect(extractTagLineTexts(rendered)).toEqual(["only text", ""]);
  });

  test("picks the first text block when multiple text blocks are present", () => {
    const rendered: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    ];
    expect(extractTagLineTexts(rendered)).toEqual(["first"]);
  });

  test("returns empty array for empty input", () => {
    expect(extractTagLineTexts([])).toEqual([]);
  });
});

// ── contentBlocks preservation (PR 3 behavioural change) ─────────────────────

describe("renderSlackTranscript — replayable content-block preservation", () => {
  // PR 3 flips the behaviour established in PR 2: when `contentBlocks` is
  // populated, the renderer preserves replayable Anthropic blocks
  // (tool_use, tool_result, thinking, redacted_thinking, image, file)
  // verbatim alongside the tag line. Non-replayable blocks (ui_surface,
  // server_tool_use, web_search_tool_result, unknown types) are stripped.
  // Legacy rows (no contentBlocks field) continue to render as a single
  // text block.

  test("[text, tool_use] assistant row preserves tool_use after tag line", () => {
    const base: RenderableSlackMessage = {
      ...userMsg(TS_14_25, "@assistant", "looking it up", {
        role: "assistant",
      }),
      contentBlocks: [
        { type: "text", text: "looking it up" },
        { type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } },
      ],
    };
    const out = renderSlackTranscript([base]);
    expect(out).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "[14:25 @assistant]: looking it up" },
          { type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } },
        ],
      },
    ]);
  });

  test("[tool_result] user row emits only tool_result — no tag line", () => {
    const base: RenderableSlackMessage = {
      ...userMsg(TS_14_25, "@alice", ""),
      contentBlocks: [
        { type: "tool_result", tool_use_id: "tu_1", content: "result text" },
      ],
    };
    const out = renderSlackTranscript([base]);
    expect(out).toEqual([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "result text" },
        ],
      },
    ]);
  });

  test("[thinking, text] assistant row preserves thinking before tag line (order preserved)", () => {
    const base: RenderableSlackMessage = {
      ...userMsg(TS_14_25, "@assistant", "here's the answer", {
        role: "assistant",
      }),
      contentBlocks: [
        { type: "thinking", thinking: "let me think", signature: "sig-abc" },
        { type: "text", text: "here's the answer" },
      ],
    };
    const out = renderSlackTranscript([base]);
    expect(out).toEqual([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me think", signature: "sig-abc" },
          { type: "text", text: "[14:25 @assistant]: here's the answer" },
        ],
      },
    ]);
  });

  test("[text, tool_use, tool_result] assistant row (degenerate) preserves order", () => {
    // Degenerate but possible via the cleanAssistantContent path — rows
    // that carry both tool_use and tool_result in the same message. The
    // renderer passes them through in order.
    const base: RenderableSlackMessage = {
      ...userMsg(TS_14_25, "@assistant", "doing a thing", {
        role: "assistant",
      }),
      contentBlocks: [
        { type: "text", text: "doing a thing" },
        { type: "tool_use", id: "tu_A", name: "op", input: {} },
        { type: "tool_result", tool_use_id: "tu_A", content: "ok" },
      ],
    };
    const out = renderSlackTranscript([base]);
    expect(out).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "[14:25 @assistant]: doing a thing" },
          { type: "tool_use", id: "tu_A", name: "op", input: {} },
          { type: "tool_result", tool_use_id: "tu_A", content: "ok" },
        ],
      },
    ]);
  });

  test("[text, ui_surface] assistant row strips ui_surface — only tag line remains", () => {
    const base: RenderableSlackMessage = {
      ...userMsg(TS_14_25, "@assistant", "reply body", { role: "assistant" }),
      contentBlocks: [
        { type: "text", text: "reply body" },
        // ui_surface is local-only UI scaffolding and must not leak into
        // the replayable output. Typed as a generic shape here because
        // ui_surface is not part of the Anthropic ContentBlock union.
        { type: "ui_surface", foo: "bar" } as unknown as never,
      ] as never,
    };
    const out = renderSlackTranscript([base]);
    expect(out).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "[14:25 @assistant]: reply body" }],
      },
    ]);
  });

  test("[text, server_tool_use] assistant row strips server_tool_use (unknown to replay)", () => {
    const base: RenderableSlackMessage = {
      ...userMsg(TS_14_25, "@assistant", "web search", { role: "assistant" }),
      contentBlocks: [
        { type: "text", text: "web search" },
        {
          type: "server_tool_use",
          id: "st_1",
          name: "web_search",
          input: { q: "x" },
        },
      ],
    };
    const out = renderSlackTranscript([base]);
    expect(out).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "[14:25 @assistant]: web search" }],
      },
    ]);
  });

  test("[image, text] user row preserves image before tag line (order preserved)", () => {
    const base: RenderableSlackMessage = {
      ...userMsg(TS_14_25, "@alice", "check this out"),
      contentBlocks: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "base64data==",
          },
        },
        { type: "text", text: "check this out" },
      ],
    };
    const out = renderSlackTranscript([base]);
    expect(out).toEqual([
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "base64data==",
            },
          },
          { type: "text", text: "[14:25 @alice]: check this out" },
        ],
      },
    ]);
  });

  test("deleted row with [text, tool_use] contentBlocks emits only the deleted tag line", () => {
    const base: RenderableSlackMessage = {
      ...userMsg(TS_14_25, "@alice", "(removed)", { deletedAt: MS_14_32 }),
      contentBlocks: [
        { type: "text", text: "old body" },
        { type: "tool_use", id: "tu_zombie", name: "op", input: {} },
      ],
    };
    const out = renderSlackTranscript([base]);
    expect(out).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "[14:25 @alice — deleted 14:32]" }],
      },
    ]);
  });

  test("legacy row (contentBlocks undefined) renders as single tag line — unchanged", () => {
    const base = userMsg(TS_14_25, "@alice", "legacy plain");
    // No `contentBlocks` field assigned — emulates a row whose JSON content
    // failed to parse or predates the plumbing.
    expect(base.contentBlocks).toBeUndefined();
    const out = renderSlackTranscript([base]);
    expect(out).toEqual([
      textMsg("user", "[14:25 @alice]: legacy plain"),
    ]);
  });

  test("legacy row with empty contentBlocks array also falls back to single tag line", () => {
    const base: RenderableSlackMessage = {
      ...userMsg(TS_14_25, "@alice", "empty blocks"),
      contentBlocks: [],
    };
    const out = renderSlackTranscript([base]);
    expect(out).toEqual([textMsg("user", "[14:25 @alice]: empty blocks")]);
  });

  test("reaction row ignores contentBlocks and renders the single reaction tag line", () => {
    // Reactions go through the reaction path and never touch the
    // replayable-block preservation. Even if contentBlocks were somehow
    // populated on a reaction row, the tool blocks must not leak through.
    const reactionBase = reactionMsg(TS_14_28, "@bob", "👍", TS_14_25, "added");
    const withBlocks: RenderableSlackMessage = {
      ...reactionBase,
      contentBlocks: [
        { type: "tool_use", id: "tu_stray", name: "op", input: {} },
      ],
    };
    const out = renderSlackTranscript([withBlocks]);
    const alias = parentAlias(TS_14_25);
    expect(out).toEqual([
      textMsg("user", `[14:28 @bob reacted 👍 to ${alias}]`),
    ]);
  });
});
