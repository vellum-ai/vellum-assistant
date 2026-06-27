import { describe, expect, test } from "bun:test";

import {
  applyEvent,
  rebuildBase,
  type RollingBase,
  type SeqEnvelope,
} from "@/domains/chat/transcript/rolling-base";
import type { AssistantEvent } from "@/types/event-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEED: RollingBase = {
  messages: [],
  hasMore: false,
  oldestTimestamp: null,
  oldestMessageId: null,
  seq: 0,
};

// Minimal valid wire events — the reducer reads only the fields below.
function ev(seq: number, message: AssistantEvent): SeqEnvelope {
  return { seq, timestampMs: 1_000 + seq, message };
}
function userEcho(seq: number, id: string, text: string): SeqEnvelope {
  return ev(seq, { type: "user_message_echo", messageId: id, text } as AssistantEvent);
}
function textDelta(seq: number, id: string, text: string): SeqEnvelope {
  return ev(seq, { type: "assistant_text_delta", messageId: id, text } as AssistantEvent);
}
function thinkingDelta(seq: number, id: string, thinking: string): SeqEnvelope {
  return ev(seq, {
    type: "assistant_thinking_delta",
    messageId: id,
    thinking,
  } as AssistantEvent);
}
function complete(seq: number, id: string): SeqEnvelope {
  return ev(seq, { type: "message_complete", messageId: id } as AssistantEvent);
}

// A representative turn: user echo → reasoning → answer → finalize.
function cleanTurn(): SeqEnvelope[] {
  return [
    userEcho(1, "u1", "build me a dashboard"),
    thinkingDelta(2, "a1", "let me consider the layout"),
    thinkingDelta(3, "a1", " and the data model"),
    textDelta(4, "a1", "Here is"),
    textDelta(5, "a1", " your dashboard."),
    complete(6, "a1"),
  ];
}

// Deterministic PRNG (mulberry32) so the randomized cases are reproducible.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Inject replays of already-emitted events at random positions. Every injected
// event has seq <= some earlier event, modelling reconnect replay / resync
// overlap — all must be idempotent no-ops.
function withReplays(
  events: SeqEnvelope[],
  random: () => number,
): SeqEnvelope[] {
  const out: SeqEnvelope[] = [];
  for (let i = 0; i < events.length; i++) {
    out.push(events[i]!);
    if (i > 0 && random() < 0.6) {
      const replayIdx = Math.floor(random() * (i + 1));
      out.push(events[replayIdx]!); // a duplicate of an already-applied event
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rolling-base reducer", () => {
  test("rebuild is deterministic — no clock/uuid leak in the fold", () => {
    // Re-deriving the same seed+events twice must be byte-identical. A
    // `Date.now()` / `crypto.randomUUID()` in a row-opening path would fail
    // this immediately.
    const events = cleanTurn();
    expect(rebuildBase(SEED, events)).toEqual(rebuildBase(SEED, events));
  });

  test("the invariant: a noisy (replayed) stream equals the clean stream", () => {
    // doc §10 — incremental application of a stream carrying duplicates equals
    // full re-derivation of the clean stream. Certified across many seeds.
    const clean = cleanTurn();
    const cleanBase = rebuildBase(SEED, clean);
    for (let seed = 1; seed <= 200; seed++) {
      const noisy = withReplays(clean, rng(seed));
      expect(rebuildBase(SEED, noisy)).toEqual(cleanBase);
    }
  });

  test("idempotent: re-applying a folded event is a no-op (same reference)", () => {
    const once = applyEvent(SEED, textDelta(1, "a1", "hello"));
    const twice = applyEvent(once, textDelta(1, "a1", "hello"));
    expect(twice).toBe(once);
  });

  test("drops any event at or below the base version", () => {
    const base = rebuildBase(SEED, cleanTurn()); // seq advances to 6
    const stale = applyEvent(base, textDelta(4, "a1", " (replayed)"));
    expect(stale).toBe(base);
  });

  test("advances the version to the highest seq folded in", () => {
    const base = rebuildBase(SEED, cleanTurn());
    expect(base.seq).toBe(6);
  });

  test("total: an unfolded event type leaves the base unchanged", () => {
    const base = rebuildBase(SEED, cleanTurn());
    const after = applyEvent(base, {
      seq: 7,
      message: { type: "sync_changed" } as AssistantEvent,
    });
    // Content is untouched; only the version cursor advances.
    expect(after.messages).toBe(base.messages);
    expect(after.seq).toBe(7);
  });

  test("opens a row stamped deterministically from the event, then appends", () => {
    const base = rebuildBase(SEED, [
      thinkingDelta(2, "a1", "reasoning"),
      textDelta(3, "a1", "answer"),
    ]);
    const assistant = base.messages.find((m) => m.id === "a1");
    expect(assistant?.timestamp).toBe(1_002); // 1000 + seq(2): the opening event
    expect(assistant?.thinkingSegments).toEqual(["reasoning"]);
    expect(assistant?.textSegments).toEqual(["answer"]);
  });

  test("preserves the snapshot page fields (it IS the /messages shape)", () => {
    const seeded: RollingBase = {
      messages: [],
      hasMore: true,
      oldestTimestamp: 123,
      oldestMessageId: "old",
      seq: 0,
    };
    const after = rebuildBase(seeded, [textDelta(1, "a1", "hi")]);
    expect(after.hasMore).toBe(true);
    expect(after.oldestTimestamp).toBe(123);
    expect(after.oldestMessageId).toBe("old");
  });
});
