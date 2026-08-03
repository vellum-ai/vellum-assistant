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

  test("appends a denied-tools note to an inlined completion", () => {
    const msg = buildSubagentTerminalMessage({
      label: "write-report",
      subagentId: "sa-7",
      isFork: false,
      outcome: "completed",
      silent: false,
      finalText: "Here is what I found.",
      deniedTools: ["file_write"],
    });

    expect(msg).toContain("Here is what I found.");
    expect(msg).toContain("attempted file_write");
    expect(msg).toContain("does not permit it");
    expect(msg).toContain("re-spawn with a role that includes it");
    expect(msg).toContain("coder");
  });

  test("appends a pluralized denied-tools note to a read-pointer completion", () => {
    const msg = buildSubagentTerminalMessage({
      label: "empty-write",
      subagentId: "sa-8",
      isFork: false,
      outcome: "completed",
      silent: false,
      finalText: "   ",
      deniedTools: ["file_write", "file_edit"],
    });

    expect(msg).toContain('subagent_read with subagent_id "sa-8"');
    expect(msg).toContain("attempted file_write, file_edit");
    expect(msg).toContain("does not permit them");
    expect(msg).toContain("re-spawn with a role that includes them");
  });

  test("omits the denied-tools note when none were denied", () => {
    const msg = buildSubagentTerminalMessage({
      label: "clean",
      subagentId: "sa-9",
      isFork: false,
      outcome: "completed",
      silent: false,
      finalText: "All done.",
      deniedTools: [],
    });

    expect(msg).not.toContain("does not permit");
    expect(msg).not.toContain("re-spawn");
  });

  test("inlines the final tool output for a budget-capped run instead of the stale preamble", () => {
    const msg = buildSubagentTerminalMessage({
      label: "long-run",
      subagentId: "sa-10",
      isFork: false,
      outcome: "completed",
      silent: false,
      // When the hard cap fires, the loop stops after appending the final tool
      // results, so the trailing assistant text is the pre-tool preamble — a
      // stale snapshot that hides the last iteration's output.
      finalText: "I'll inspect the config next...",
      iterationBudgetReached: true,
      // The last real work lives in the trailing tool-result message.
      finalToolResultText: "CONFIG: port=8080\nmode=prod",
    });

    // The stale preamble must NOT be presented as the result.
    expect(msg).not.toContain("I'll inspect the config next");
    // The parent reaches the final iteration's tool output directly — this is
    // the content subagent_read (assistant messages only) cannot surface.
    expect(msg).toContain("CONFIG: port=8080");
    expect(msg).toContain("final iteration's tool output");
    expect(msg).not.toContain("truncated"); // short output — not truncated
    // The read pointer is retained for the earlier assistant history...
    expect(msg).toContain('subagent_read with subagent_id "sa-10"');
    expect(msg).toContain("earlier assistant messages");
    // ...and the run is flagged as truncated so the parent can continue.
    expect(msg).toContain("reached its iteration budget");
    expect(msg).toContain("may be incomplete");
    expect(msg).toContain("re-spawn it to continue");
  });

  test("bounds an oversized inlined tool output and says it truncated", () => {
    const big = "X".repeat(5_000);
    const msg = buildSubagentTerminalMessage({
      label: "long-run",
      subagentId: "sa-10b",
      isFork: false,
      outcome: "completed",
      silent: false,
      finalText: "preamble",
      iterationBudgetReached: true,
      finalToolResultText: big,
    });

    // Bounded to the head; the note reports the exact budget honestly.
    expect(msg).toContain("truncated to the first 4000 characters");
    expect(msg).toContain("X".repeat(4_000));
    expect(msg).not.toContain("X".repeat(4_001));
    expect(msg).toContain('subagent_read with subagent_id "sa-10b"');
    expect(msg).toContain("re-spawn it to continue");
  });

  test("fork capped-run inline points read at last_n: 1 and can stay internal", () => {
    const msg = buildSubagentTerminalMessage({
      label: "fork-run",
      subagentId: "sa-10c",
      isFork: true,
      outcome: "completed",
      silent: true,
      finalText: "I'll keep going...",
      iterationBudgetReached: true,
      finalToolResultText: "partial fork findings",
    });

    expect(msg).toContain("partial fork findings");
    expect(msg).toContain(
      'subagent_read with subagent_id "sa-10c" and last_n: 1',
    );
    expect(msg).toContain("Keep the result internal.");
  });

  test("a queued follow-up still defers a capped run to the read pointer, not the tool output", () => {
    const msg = buildSubagentTerminalMessage({
      label: "interactive-cap",
      subagentId: "sa-10d",
      isFork: false,
      outcome: "completed",
      silent: false,
      finalText: "stale preamble",
      iterationBudgetReached: true,
      finalToolResultText: "tool output that is also stale",
      deferred: true,
    });

    // A draining follow-up turn supersedes both the preamble and this snapshot.
    expect(msg).not.toContain("tool output that is also stale");
    expect(msg).toContain("Queued follow-up guidance is still being processed");
    expect(msg).toContain('subagent_read with subagent_id "sa-10d"');
  });

  test("falls back to the read pointer when a capped run left no tool output", () => {
    const msg = buildSubagentTerminalMessage({
      label: "long-empty-tools",
      subagentId: "sa-10e",
      isFork: false,
      outcome: "completed",
      silent: false,
      finalText: "I'll inspect next...",
      iterationBudgetReached: true,
      // No trailing tool-result content to inline.
      finalToolResultText: "   ",
    });

    expect(msg).not.toContain("I'll inspect next");
    expect(msg).toContain('subagent_read with subagent_id "sa-10e"');
    expect(msg).toContain("reached its iteration budget");
    expect(msg).toContain("re-spawn it to continue");
  });

  test("attaches the truncation notice to the read-pointer path too", () => {
    const msg = buildSubagentTerminalMessage({
      label: "long-empty",
      subagentId: "sa-11",
      isFork: false,
      outcome: "completed",
      silent: false,
      finalText: "   ",
      iterationBudgetReached: true,
    });

    expect(msg).toContain('subagent_read with subagent_id "sa-11"');
    expect(msg).toContain("reached its iteration budget");
  });

  test("omits the truncation notice on a normally-completed run", () => {
    const msg = buildSubagentTerminalMessage({
      label: "normal",
      subagentId: "sa-12",
      isFork: false,
      outcome: "completed",
      silent: false,
      finalText: "Done cleanly.",
    });

    expect(msg).not.toContain("iteration budget");
  });

  test("normal completion output is byte-identical (unaffected by the capped-run path)", () => {
    const opts = {
      label: "research-pricing",
      subagentId: "sa-1",
      isFork: false as const,
      outcome: "completed" as const,
      silent: false,
      finalText: "Competitor X charges $20/mo.",
    };

    const msg = buildSubagentTerminalMessage(opts);

    // Frozen expectation: the inline-completion wording must not drift when the
    // budget-capped tool-output path is added.
    expect(msg).toBe(
      '[Subagent "research-pricing" completed — result below]\n\n' +
        "Competitor X charges $20/mo.\n\n" +
        "(Incorporate this into your reply to the user as appropriate.)",
    );

    // A stray finalToolResultText can never leak into a non-capped completion.
    const withToolText = buildSubagentTerminalMessage({
      ...opts,
      finalToolResultText: "should be ignored",
    });
    expect(withToolText).toBe(msg);
  });
});
