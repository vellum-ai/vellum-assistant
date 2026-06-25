/**
 * Tests for `createConsultDeadline` — the advisor consult's progress-aware
 * timeout. Uses short real timers with generous (>=3x) margins so a streamed
 * chunk reliably lands inside the idle window without timing flakiness.
 */
import { describe, expect, test } from "bun:test";

import { createConsultDeadline } from "../tools/subagent/consult-deadline.js";

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("createConsultDeadline", () => {
  test("streamed progress keeps the consult alive past the idle window", async () => {
    // Record progress every 25ms against a 150ms idle window (6x margin). Each
    // chunk resets the window, so it must never abort over ~200ms of streaming.
    const d = createConsultDeadline({ idleMs: 150, maxMs: 10_000 });
    try {
      for (let i = 0; i < 8; i++) {
        await delay(25);
        expect(d.signal.aborted).toBe(false);
        d.recordProgress();
      }
    } finally {
      d.dispose();
    }
  });

  test("aborts after the idle window once progress stops", async () => {
    const d = createConsultDeadline({ idleMs: 50, maxMs: 10_000 });
    try {
      expect(d.signal.aborted).toBe(false);
      await delay(250); // 5x the idle window with no progress
      expect(d.signal.aborted).toBe(true);
    } finally {
      d.dispose();
    }
  });

  test("aborts at the absolute max even under steady progress", async () => {
    // Idle window can't fire (huge); the short max must, despite steady chunks.
    const d = createConsultDeadline({ idleMs: 10_000, maxMs: 70 });
    try {
      for (let i = 0; i < 8; i++) {
        await delay(25);
        d.recordProgress();
      }
      expect(d.signal.aborted).toBe(true); // ~200ms elapsed > 70ms max
    } finally {
      d.dispose();
    }
  });

  test("dispose() cancels both timers — no late abort", async () => {
    const d = createConsultDeadline({ idleMs: 40, maxMs: 40 });
    d.dispose();
    await delay(150); // well past both windows
    expect(d.signal.aborted).toBe(false);
  });
});
