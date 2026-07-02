import { describe, expect, test } from "bun:test";

import { AcpAgentProcess } from "./agent-process.js";
import type { AcpAgentConfig } from "./types.js";

const config: AcpAgentConfig = { command: "noop", args: [] };

// The client factory is never invoked in these tests (no spawn), so a stub is
// sufficient.
const clientFactory = (() => ({})) as never;

function newProcess(): AcpAgentProcess {
  return new AcpAgentProcess("test-agent", config, clientFactory);
}

// retainStderr is the private handler path the stderr "data" listener calls
// after logging; feed it directly to keep the test deterministic (no real
// child process or stream timing).
function feed(proc: AcpAgentProcess, line: string): void {
  (proc as unknown as { retainStderr(text: string): void }).retainStderr(line);
}

describe("AcpAgentProcess.recentStderr", () => {
  test("returns empty string before any stderr is captured", () => {
    expect(newProcess().recentStderr()).toBe("");
  });

  test("retains captured lines joined by newlines, in order", () => {
    const proc = newProcess();
    feed(proc, "line 1");
    feed(proc, "line 2");
    feed(proc, "line 3");

    expect(proc.recentStderr()).toBe("line 1\nline 2\nline 3");
  });

  test("evicts oldest lines once the byte cap is exceeded", () => {
    const proc = newProcess();
    // Each line is ~1 KB; a handful exceeds the ~4 KB cap and forces eviction
    // of the earliest lines while preserving newest-line ordering.
    const kb = "x".repeat(1024);
    for (let i = 0; i < 8; i++) {
      feed(proc, `${i}:${kb}`);
    }

    const retained = proc.recentStderr().split("\n");
    // Oldest ("0:") evicted, newest ("7:") retained, still in insertion order.
    expect(retained.at(0)).not.toContain("0:");
    expect(retained.at(-1)).toContain("7:");
    expect(Buffer.byteLength(proc.recentStderr())).toBeLessThanOrEqual(
      4096 + kb.length,
    );

    const indices = retained.map((l) => Number(l.split(":")[0]));
    const sorted = [...indices].sort((a, b) => a - b);
    expect(indices).toEqual(sorted);
  });

  test("keeps at least the newest line even when it alone exceeds the cap", () => {
    const proc = newProcess();
    const huge = "y".repeat(8192);
    feed(proc, huge);

    expect(proc.recentStderr()).toBe(huge);
  });

  test("recentStderr is pure: repeated reads do not clear the buffer", () => {
    const proc = newProcess();
    feed(proc, "only line");

    expect(proc.recentStderr()).toBe("only line");
    expect(proc.recentStderr()).toBe("only line");
  });
});

describe("AcpAgentProcess.markStderr / stderrSince", () => {
  test("stderrSince returns only lines produced after the mark", () => {
    const proc = newProcess();
    feed(proc, "before 1");
    feed(proc, "before 2");

    const mark = proc.markStderr();
    feed(proc, "after 1");
    feed(proc, "after 2");

    expect(proc.stderrSince(mark)).toBe("after 1\nafter 2");
  });

  test("a mark taken after all lines excludes everything retained so far", () => {
    const proc = newProcess();
    feed(proc, "line 1");
    feed(proc, "line 2");

    const mark = proc.markStderr();
    expect(proc.stderrSince(mark)).toBe("");
  });

  test("stderrSince(0) returns all retained lines, like recentStderr", () => {
    const proc = newProcess();
    feed(proc, "line 1");
    feed(proc, "line 2");

    expect(proc.stderrSince(0)).toBe(proc.recentStderr());
  });

  test("mark is monotonic across eviction: seq keeps counting evicted lines", () => {
    const proc = newProcess();
    // Overflow the byte cap so early lines are evicted, then mark and add one
    // fresh line: only the post-mark line comes back, unaffected by eviction.
    const kb = "z".repeat(1024);
    for (let i = 0; i < 8; i++) {
      feed(proc, `${i}:${kb}`);
    }

    const mark = proc.markStderr();
    feed(proc, "fresh failure");

    expect(proc.stderrSince(mark)).toBe("fresh failure");
  });
});
