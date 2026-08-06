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
    expect(msg).toContain("builder");
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

  test("appends the machine stats footer to an inlined completion", () => {
    const msg = buildSubagentTerminalMessage({
      label: "refactor",
      subagentId: "sa-10",
      isFork: false,
      outcome: "completed",
      silent: false,
      finalText: "Renamed the helper across the module.",
      stats: { calls: 7, succeeded: 6, filesWritten: 2 },
    });

    expect(msg).toContain("Renamed the helper across the module.");
    expect(msg).toContain(
      "[stats: 7 tool calls, 6 succeeded, files written via file_write/file_edit: 2]",
    );
  });

  test("appends the machine stats footer to a read-pointer completion", () => {
    const msg = buildSubagentTerminalMessage({
      label: "quiet",
      subagentId: "sa-11",
      isFork: false,
      outcome: "completed",
      silent: false,
      finalText: "   ",
      stats: { calls: 1, succeeded: 1, filesWritten: 0 },
    });

    expect(msg).toContain('subagent_read with subagent_id "sa-11"');
    // Singular reading for a single call, so the footer never says "1 tool calls".
    expect(msg).toContain(
      "[stats: 1 tool call, 1 succeeded, files written via file_write/file_edit: 0]",
    );
  });

  test("a zero-call run gets the unverified warning instead of a count", () => {
    const msg = buildSubagentTerminalMessage({
      label: "claims-work",
      subagentId: "sa-12",
      isFork: false,
      outcome: "completed",
      silent: false,
      finalText: "I created the report and saved it to disk.",
      stats: { calls: 0, succeeded: 0, filesWritten: 0 },
    });

    expect(msg).toContain(
      "[stats: no tools were used by this subagent; treat any claims of executed work as unverified]",
    );
    expect(msg).not.toContain("tool calls,");
  });

  test("the file count names the two tools it comes from", () => {
    // A builder runs on the parent's whole tool surface and can write with a
    // bash heredoc, a document tool, or an MCP tool, none of which the counter
    // sees. A bare "files written: 0" next to a builder reporting the files it
    // created would read as fabricated work, so the footer says which
    // instrument it measured.
    const msg = buildSubagentTerminalMessage({
      label: "shell-builder",
      subagentId: "sa-14",
      isFork: false,
      outcome: "completed",
      silent: false,
      finalText: "Created scripts/export.py with a heredoc.",
      stats: { calls: 14, succeeded: 14, filesWritten: 0 },
    });

    expect(msg).toContain(
      "[stats: 14 tool calls, 14 succeeded, files written via file_write/file_edit: 0]",
    );
    expect(msg).not.toContain("succeeded, files written: 0");
  });

  test("omits the stats footer when no stats were harvested", () => {
    const msg = buildSubagentTerminalMessage({
      label: "no-stats",
      subagentId: "sa-13",
      isFork: false,
      outcome: "completed",
      silent: false,
      finalText: "Done.",
    });

    expect(msg).not.toContain("[stats:");
  });
});
