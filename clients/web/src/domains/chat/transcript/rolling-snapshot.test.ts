import { describe, expect, test } from "bun:test";

import {
  applyEvent,
  applyEventsToHistory,
  resolveSnapshot,
} from "@/domains/chat/transcript/rolling-snapshot";
import type { PaginatedHistoryResult } from "@/domains/chat/transcript/types";
import type { AssistantEvent } from "@/types/event-types";
import type { AssistantEventEnvelope } from "@vellumai/assistant-api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEED: PaginatedHistoryResult = {
  messages: [],
  hasMore: false,
  oldestTimestamp: null,
  oldestMessageId: null,
  seq: 0,
};

// `emittedAt` is derived from `seq` so the deterministic creation stamp is
// `1000 + seq` — the reducer parses it back to that epoch ms.
function env(seq: number, message: AssistantEvent): AssistantEventEnvelope {
  return {
    id: `e${seq}`,
    seq,
    emittedAt: new Date(1000 + seq).toISOString(),
    message,
  } as AssistantEventEnvelope;
}
const stampOf = (seq: number) => 1000 + seq;

const userEcho = (seq: number, id: string, text: string) =>
  env(seq, { type: "user_message_echo", messageId: id, text } as AssistantEvent);
const textDelta = (seq: number, id: string, text: string) =>
  env(seq, { type: "assistant_text_delta", messageId: id, text } as AssistantEvent);
const thinkingDelta = (seq: number, id: string, thinking: string) =>
  env(seq, {
    type: "assistant_thinking_delta",
    messageId: id,
    thinking,
  } as AssistantEvent);
const complete = (seq: number, id: string) =>
  env(seq, { type: "message_complete", messageId: id } as AssistantEvent);
const toolUseStart = (seq: number, id: string, toolUseId: string, name: string) =>
  env(seq, {
    type: "tool_use_start",
    messageId: id,
    toolUseId,
    toolName: name,
    input: {},
  } as AssistantEvent);
const surfaceShow = (seq: number, id: string, surfaceId: string) =>
  env(seq, {
    type: "ui_surface_show",
    messageId: id,
    surfaceId,
    surfaceType: "form",
    data: {},
  } as AssistantEvent);
const reactionUpdated = (
  seq: number,
  messageId: string,
  reactions: Array<{ emoji: string; actor: string; createdAt: number }>,
) =>
  env(seq, {
    type: "message_reaction_updated",
    conversationId: "c1",
    messageId,
    reactions,
  } as AssistantEvent);

// A representative turn: user echo → reasoning → answer → finalize.
const cleanTurn = (): AssistantEventEnvelope[] => [
  userEcho(1, "u1", "build me a dashboard"),
  thinkingDelta(2, "a1", "let me consider the layout"),
  thinkingDelta(3, "a1", " and the data model"),
  textDelta(4, "a1", "Here is"),
  textDelta(5, "a1", " your dashboard."),
  complete(6, "a1"),
];

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

// Inject replays of already-emitted events at random positions — every injected
// event has seq <= an earlier one, modelling reconnect replay / resync overlap.
function withReplays(
  events: AssistantEventEnvelope[],
  random: () => number,
): AssistantEventEnvelope[] {
  const out: AssistantEventEnvelope[] = [];
  for (let i = 0; i < events.length; i++) {
    out.push(events[i]!);
    if (i > 0 && random() < 0.6) {
      out.push(events[Math.floor(random() * (i + 1))]!);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rolling-snapshot reducer", () => {
  test("rebuild is deterministic — no clock/uuid leak in the fold", () => {
    const events = cleanTurn();
    expect(applyEventsToHistory(SEED, events)).toEqual(
      applyEventsToHistory(SEED, events),
    );
  });

  test("terminal tool-call finalize is deterministic (Codex P2)", () => {
    // A running tool call finalized by `message_complete` must stamp
    // `completedAt` from the event, not `Date.now()`, or rebuild diverges.
    const events = [toolUseStart(1, "a1", "t1", "bash"), complete(2, "a1")];
    const a = applyEventsToHistory(SEED, events);
    const b = applyEventsToHistory(SEED, events);
    expect(a).toEqual(b);
    const tool = a.messages[0]?.toolCalls?.[0];
    expect(tool?.completedAt).toBe(stampOf(2));
  });

  test("the invariant: a noisy (replayed) stream equals the clean stream", () => {
    const clean = cleanTurn();
    const cleanHistory = applyEventsToHistory(SEED, clean);
    for (let seed = 1; seed <= 200; seed++) {
      const noisy = withReplays(clean, rng(seed));
      expect(applyEventsToHistory(SEED, noisy)).toEqual(cleanHistory);
    }
  });

  test("idempotent: re-applying a folded event is a no-op (same reference)", () => {
    const once = applyEvent(SEED, textDelta(1, "a1", "hello"));
    const twice = applyEvent(once, textDelta(1, "a1", "hello"));
    expect(twice).toBe(once);
  });

  test("drops any event at or below the history version", () => {
    const base = applyEventsToHistory(SEED, cleanTurn()); // seq advances to 6
    expect(applyEvent(base, textDelta(4, "a1", " (replayed)"))).toBe(base);
  });

  test("advances the version to the highest seq folded in", () => {
    expect(applyEventsToHistory(SEED, cleanTurn()).seq).toBe(6);
  });

  test("total: an unfolded event type leaves message content unchanged", () => {
    const base = applyEventsToHistory(SEED, cleanTurn());
    const after = applyEvent(base, env(7, { type: "sync_changed" } as AssistantEvent));
    expect(after.messages).toBe(base.messages); // content untouched...
    expect(after.seq).toBe(7); // ...only the version cursor advances
  });

  test("opens a row stamped deterministically from the event, then appends", () => {
    const base = applyEventsToHistory(SEED, [
      thinkingDelta(2, "a1", "reasoning"),
      textDelta(3, "a1", "answer"),
    ]);
    const assistant = base.messages.find((m) => m.id === "a1");
    expect(assistant?.timestamp).toBe(stampOf(2)); // the opening event's stamp
    expect(assistant?.thinkingSegments).toEqual(["reasoning"]);
    expect(assistant?.textSegments).toEqual(["answer"]);
  });

  test("folds tool-call and surface events into the turn", () => {
    const base = applyEventsToHistory(SEED, [
      toolUseStart(1, "a1", "t1", "bash"),
      surfaceShow(2, "a1", "s1"),
    ]);
    const assistant = base.messages.find((m) => m.id === "a1");
    expect(assistant?.toolCalls?.map((t) => t.id)).toEqual(["t1"]);
    expect(assistant?.surfaces?.map((s) => s.surfaceId)).toEqual(["s1"]);
  });

  test("preserves the snapshot page fields (it IS the /messages shape)", () => {
    const seeded: PaginatedHistoryResult = {
      messages: [],
      hasMore: true,
      oldestTimestamp: 123,
      oldestMessageId: "old",
      seq: 0,
    };
    const after = applyEventsToHistory(seeded, [textDelta(1, "a1", "hi")]);
    expect(after.hasMore).toBe(true);
    expect(after.oldestTimestamp).toBe(123);
    expect(after.oldestMessageId).toBe("old");
  });

  describe("resolveSnapshot (seed / resync)", () => {
    test("a null tail (gap / no anchor) leaves the snapshot standing alone", () => {
      const snapshot = applyEventsToHistory(SEED, [textDelta(1, "a1", "persisted")]);
      expect(resolveSnapshot(snapshot, null)).toBe(snapshot);
    });

    test("replays the buffered tail onto the snapshot", () => {
      const snapshot = applyEventsToHistory(SEED, [
        userEcho(1, "u1", "hi"),
        textDelta(2, "a1", "persisted"),
      ]);
      const resolved = resolveSnapshot(snapshot, [textDelta(3, "a1", " + live")]);
      expect(resolved.messages.find((m) => m.id === "a1")?.textSegments).toEqual([
        "persisted + live",
      ]);
      expect(resolved.seq).toBe(3);
    });

    test("idempotent: tail events already in the snapshot are dropped", () => {
      const snapshot = applyEventsToHistory(SEED, [textDelta(5, "a1", "x")]); // seq 5
      // A stale tail (<= snapshot.seq) folds to nothing.
      const resolved = resolveSnapshot(snapshot, [textDelta(4, "a1", " stale")]);
      expect(resolved.messages.find((m) => m.id === "a1")?.textSegments).toEqual(["x"]);
    });
  });

  describe("tool-call preview + inline confirmation", () => {
    const previewStart = (seq: number, id: string, toolUseId: string) =>
      env(seq, {
        type: "tool_use_preview_start",
        messageId: id,
        toolUseId,
        toolName: "bash",
      } as AssistantEvent);
    const confirmationRequest = (seq: number, requestId: string, toolUseId: string) =>
      env(seq, {
        type: "confirmation_request",
        requestId,
        toolName: "bash",
        toolUseId,
        riskLevel: "low",
        input: {},
      } as AssistantEvent);
    const interactionResolved = (seq: number, requestId: string, kind: string) =>
      env(seq, {
        type: "interaction_resolved",
        requestId,
        kind,
        state: "cancelled",
      } as AssistantEvent);

    test("preview-start opens a running tool card the later tool_use_start fills in", () => {
      const afterPreview = applyEvent(SEED, previewStart(1, "a1", "t1"));
      const previewCard = afterPreview.messages
        .find((m) => m.id === "a1")
        ?.toolCalls?.find((tc) => tc.id === "t1");
      expect(previewCard).toBeDefined();

      const afterStart = applyEvent(
        afterPreview,
        toolUseStart(2, "a1", "t1", "bash"),
      );
      // Same card (merged, not duplicated).
      expect(
        afterStart.messages.find((m) => m.id === "a1")?.toolCalls,
      ).toHaveLength(1);
    });

    test("confirmation_request attaches, interaction_resolved clears the marker", () => {
      const withTool = applyEventsToHistory(SEED, [toolUseStart(1, "a1", "t1", "bash")]);
      const attached = applyEvent(withTool, confirmationRequest(2, "cr-1", "t1"));
      const tc = attached.messages.find((m) => m.id === "a1")?.toolCalls?.[0];
      expect(tc?.pendingConfirmation?.requestId).toBe("cr-1");

      const cleared = applyEvent(attached, interactionResolved(3, "cr-1", "confirmation"));
      expect(
        cleared.messages.find((m) => m.id === "a1")?.toolCalls?.[0]
          ?.pendingConfirmation,
      ).toBeUndefined();
    });

    test("interaction_resolved for a non-confirmation kind leaves content untouched", () => {
      const attached = applyEventsToHistory(SEED, [
        toolUseStart(1, "a1", "t1", "bash"),
        confirmationRequest(2, "cr-1", "t1"),
      ]);
      const after = applyEvent(attached, interactionResolved(3, "cr-1", "host_bash"));
      expect(
        after.messages.find((m) => m.id === "a1")?.toolCalls?.[0]
          ?.pendingConfirmation?.requestId,
      ).toBe("cr-1");
    });
  });

  // -------------------------------------------------------------------------
  // Authoritative `processing` flag fold.
  // -------------------------------------------------------------------------
  describe("processing flag", () => {
    const turnStart = (seq: number, id: string) =>
      env(seq, { type: "assistant_turn_start", messageId: id } as AssistantEvent);
    const activityIdle = (seq: number) =>
      env(seq, { type: "assistant_activity_state", phase: "idle" } as AssistantEvent);
    const activityThinking = (seq: number) =>
      env(seq, {
        type: "assistant_activity_state",
        phase: "thinking",
      } as AssistantEvent);
    // A defined seed = a 0.8.8+ daemon that reported `processing` on /messages.
    const idleSeed: PaginatedHistoryResult = { ...SEED, processing: false };
    const busySeed: PaginatedHistoryResult = { ...SEED, processing: true };

    test("turn-start folds processing → true", () => {
      expect(applyEvent(idleSeed, turnStart(1, "a1")).processing).toBe(true);
    });

    test("assistant content folds processing → true (turn-start fallback)", () => {
      expect(applyEvent(idleSeed, textDelta(1, "a1", "hi")).processing).toBe(true);
      expect(applyEvent(idleSeed, thinkingDelta(1, "a1", "hmm")).processing).toBe(
        true,
      );
    });

    test("a non-idle activity phase keeps processing true", () => {
      expect(applyEvent(busySeed, activityThinking(1)).processing).toBe(true);
    });

    test("activity_state(idle) folds processing → false", () => {
      expect(applyEvent(busySeed, activityIdle(1)).processing).toBe(false);
    });

    test("message_complete folds processing → false", () => {
      expect(applyEvent(busySeed, complete(1, "a1")).processing).toBe(false);
    });

    test("undefined seed stays undefined — the pre-0.8.8 version sentinel", () => {
      // SEED omits `processing`; the fold must never manufacture a value, so
      // phase-only behavior is preserved for daemons that don't report it.
      const after = applyEvent(SEED, turnStart(1, "a1"));
      expect(after.processing).toBeUndefined();
    });

    test("a replayed lower-seq turn-start cannot resurrect a closed turn", () => {
      // idle at seq 5 closes the turn; a late/duplicated turn-start at seq 2 is
      // below the watermark and dropped, so processing stays false.
      const closed = applyEvent(busySeed, activityIdle(5));
      expect(closed.processing).toBe(false);
      expect(applyEvent(closed, turnStart(2, "a1")).processing).toBe(false);
    });

    test("converges under a noisy, out-of-order lifecycle stream", () => {
      // The scalar-fold analogue of the message invariant: the highest-seq
      // lifecycle event wins regardless of arrival order.
      const clean = [turnStart(1, "a1"), textDelta(2, "a1", "hi"), activityIdle(3)];
      const cleanProcessing = applyEventsToHistory(idleSeed, clean).processing;
      expect(cleanProcessing).toBe(false);
      for (let seed = 1; seed <= 50; seed++) {
        const noisy = withReplays(clean, rng(seed));
        expect(applyEventsToHistory(idleSeed, noisy).processing).toBe(
          cleanProcessing,
        );
      }
    });
  });

  describe("message_reaction_updated", () => {
    const reactions = [{ emoji: "🎉", actor: "assistant", createdAt: 5000 }];

    test("patches the target message's reactions in place", () => {
      const seeded = applyEvent(SEED, userEcho(1, "u1", "I got the job!"));
      const after = applyEvent(seeded, reactionUpdated(2, "u1", reactions));
      const target = after.messages.find((m) => m.id === "u1");
      expect(target?.reactions).toEqual(reactions);
    });

    test("replaces the reaction set rather than appending", () => {
      const seeded = applyEvent(SEED, userEcho(1, "u1", "hello"));
      const first = applyEvent(seeded, reactionUpdated(2, "u1", reactions));
      const replacement = [{ emoji: "👍", actor: "assistant", createdAt: 6000 }];
      const second = applyEvent(first, reactionUpdated(3, "u1", replacement));
      expect(second.messages.find((m) => m.id === "u1")?.reactions).toEqual(
        replacement,
      );
    });

    test("leaves history untouched when the target message is absent", () => {
      const seeded = applyEvent(SEED, userEcho(1, "u1", "hello"));
      const after = applyEvent(seeded, reactionUpdated(2, "missing", reactions));
      expect(after.messages).toBe(seeded.messages);
    });
  });
});
