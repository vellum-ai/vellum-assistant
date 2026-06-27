import { describe, expect, test } from "bun:test";

import {
  compact,
  emptySeamWindow,
  firstGap,
  ingest,
  type SeamWindow,
} from "@/domains/chat/transcript/seam-window";
import { applyEventsToHistory } from "@/domains/chat/transcript/rolling-base";
import type { PaginatedHistoryResult } from "@/domains/chat/transcript/types";
import type { AssistantEvent } from "@/types/event-types";
import type { AssistantEventEnvelope } from "@vellumai/assistant-api";

const SEED: PaginatedHistoryResult = {
  messages: [],
  hasMore: false,
  oldestTimestamp: null,
  oldestMessageId: null,
  seq: 0,
};

function env(seq: number, message: AssistantEvent): AssistantEventEnvelope {
  return {
    id: `e${seq}`,
    seq,
    emittedAt: new Date(1000 + seq).toISOString(),
    message,
  } as AssistantEventEnvelope;
}
const textDelta = (seq: number, id: string, text: string) =>
  env(seq, { type: "assistant_text_delta", messageId: id, text } as AssistantEvent);

// A clean, in-order turn: seqs 1..6.
const cleanTurn = (): AssistantEventEnvelope[] => [
  env(1, { type: "user_message_echo", messageId: "u1", text: "hi" } as AssistantEvent),
  textDelta(2, "a1", "Here"),
  textDelta(3, "a1", " is"),
  textDelta(4, "a1", " your"),
  textDelta(5, "a1", " answer."),
  env(6, { type: "message_complete", messageId: "a1" } as AssistantEvent),
];

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("seam window", () => {
  test("out-of-order ingestion then compaction equals the in-order rebuild", () => {
    const clean = cleanTurn();
    const inOrder = applyEventsToHistory(SEED, clean);
    for (let seed = 1; seed <= 200; seed++) {
      let window: SeamWindow = emptySeamWindow;
      for (const e of shuffle(clean, rng(seed))) {
        window = ingest(window, SEED.seq, e);
      }
      const { base, window: rest } = compact(SEED, window);
      expect(rest.size).toBe(0); // fully contiguous once all arrived
      expect(base).toEqual(inOrder);
    }
  });

  test("interleaved ingest+compact also converges to the in-order rebuild", () => {
    const clean = cleanTurn();
    const inOrder = applyEventsToHistory(SEED, clean);
    for (let seed = 1; seed <= 200; seed++) {
      let base = SEED;
      let window: SeamWindow = emptySeamWindow;
      for (const e of shuffle(clean, rng(seed))) {
        window = ingest(window, base.seq, e);
        ({ base, window } = compact(base, window));
      }
      expect(window.size).toBe(0);
      expect(base).toEqual(inOrder);
    }
  });

  test("compacts only the gap-free prefix; the tail parks until backfilled", () => {
    let window: SeamWindow = emptySeamWindow;
    for (const e of [textDelta(1, "a", "a"), textDelta(2, "a", "b"), textDelta(4, "a", "d")]) {
      window = ingest(window, SEED.seq, e);
    }
    const step1 = compact(SEED, window);
    expect(step1.base.seq).toBe(2); // folded 1,2; 3 is missing
    expect([...step1.window.keys()]).toEqual([4]); // 4 parked past the gap
    expect(firstGap(step1.base, step1.window)).toEqual({ expected: 3, have: 4 });

    // Backfill 3 → the prefix is contiguous again and the tail folds.
    const filled = ingest(step1.window, step1.base.seq, textDelta(3, "a", "c"));
    const step2 = compact(step1.base, filled);
    expect(step2.base.seq).toBe(4);
    expect(step2.window.size).toBe(0);
    expect(firstGap(step2.base, step2.window)).toBeNull();
  });

  test("drops duplicates and already-folded (stale) events", () => {
    const dup = ingest(ingest(emptySeamWindow, SEED.seq, textDelta(2, "a", "x")), SEED.seq, textDelta(2, "a", "x"));
    expect(dup.size).toBe(1);

    const base: PaginatedHistoryResult = { ...SEED, seq: 3 };
    const stale = ingest(emptySeamWindow, base.seq, textDelta(2, "a", "old"));
    expect(stale.size).toBe(0); // seq 2 <= base.seq 3
  });

  test("ignores events with no seq (caller owns the seqless path)", () => {
    const after = ingest(emptySeamWindow, SEED.seq, {
      id: "x",
      emittedAt: new Date(0).toISOString(),
      message: { type: "assistant_text_delta", messageId: "a", text: "x" },
    } as AssistantEventEnvelope);
    expect(after.size).toBe(0);
  });

  test("holds the window (no fold) until a snapshot anchors the version", () => {
    const cold: PaginatedHistoryResult = { ...SEED, seq: null };
    const window = ingest(emptySeamWindow, cold.seq, textDelta(5, "a", "x"));
    const { base, window: rest } = compact(cold, window);
    expect(base).toBe(cold); // no anchor → nothing folds
    expect(rest.size).toBe(1);
    expect(firstGap(cold, rest)).toBeNull(); // can't measure a gap without an anchor
  });
});
