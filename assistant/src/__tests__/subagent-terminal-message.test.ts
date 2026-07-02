import { describe, expect, test } from "bun:test";

import { buildSubagentTerminalMessage } from "../subagent/manager.js";

describe("buildSubagentTerminalMessage", () => {
  test("inlines the final synthesis for a shared completed subagent", () => {
    const msg = buildSubagentTerminalMessage({
      label: "research-pricing",
      subagentId: "sa-1",
      isFork: false,
      outcome: "completed",
      silent: false,
      finalText: "Competitor X charges $20/mo.",
    });

    expect(msg).toContain("Competitor X charges $20/mo.");
    expect(msg).toContain("completed — result below");
    expect(msg).toContain("Incorporate this into your reply");
    // The whole point: no subagent_read round-trip, nothing left to re-spawn.
    expect(msg).not.toContain("subagent_read");
    expect(msg).not.toContain("re-spawn");
  });

  test("marks a silent completion for internal use only", () => {
    const msg = buildSubagentTerminalMessage({
      label: "scan",
      subagentId: "sa-2",
      isFork: true,
      outcome: "completed",
      silent: true,
      finalText: "Internal findings.",
    });

    expect(msg).toContain("Internal findings.");
    expect(msg).toContain("internally");
    expect(msg).not.toContain("subagent_read");
  });

  test("falls back to a subagent_read pointer when there is no final text", () => {
    const msg = buildSubagentTerminalMessage({
      label: "empty-run",
      subagentId: "sa-3",
      isFork: false,
      outcome: "completed",
      silent: false,
      finalText: "   ",
    });

    expect(msg).toContain("produced no final text");
    expect(msg).toContain('subagent_read with subagent_id "sa-3"');
    expect(msg).not.toContain("last_n");
  });

  test("fork fallback points at last_n: 1 and keeps it internal", () => {
    const msg = buildSubagentTerminalMessage({
      label: "empty-fork",
      subagentId: "sa-4",
      isFork: true,
      outcome: "completed",
      silent: true,
      finalText: undefined,
    });

    expect(msg).toContain("last_n: 1");
    expect(msg).toContain("Keep the result internal.");
  });

  test("keeps the read pointer instead of inlining when a follow-up turn is queued", () => {
    const msg = buildSubagentTerminalMessage({
      label: "interactive",
      subagentId: "sa-6",
      isFork: false,
      outcome: "completed",
      silent: false,
      finalText: "Snapshot answer (stale).",
      deferred: true,
    });

    // The snapshot must NOT be inlined — newer queued output is still coming.
    expect(msg).not.toContain("Snapshot answer");
    expect(msg).toContain("Queued follow-up guidance is still being processed");
    expect(msg).toContain('subagent_read with subagent_id "sa-6"');
  });

  test("failure message surfaces the error and discourages auto-retry", () => {
    const msg = buildSubagentTerminalMessage({
      label: "broken",
      subagentId: "sa-5",
      isFork: false,
      outcome: "failed",
      silent: false,
      error: "boom",
    });

    expect(msg).toContain('[Subagent "broken" failed]');
    expect(msg).toContain("Error: boom");
    expect(msg).toContain("Do NOT re-spawn or retry");
  });
});
