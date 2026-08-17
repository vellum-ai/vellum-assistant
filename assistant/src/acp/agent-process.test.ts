import { describe, expect, test } from "bun:test";

import { AcpAgentProcess } from "./agent-process.js";
import { AcpAuthRequiredError, isAcpAuthRequired } from "./auth-required.js";
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

describe("AcpAgentProcess.stderrSince(0)", () => {
  test("returns empty string before any stderr is captured", () => {
    expect(newProcess().stderrSince(0)).toBe("");
  });

  test("retains captured lines joined by newlines, in order", () => {
    const proc = newProcess();
    feed(proc, "line 1");
    feed(proc, "line 2");
    feed(proc, "line 3");

    expect(proc.stderrSince(0)).toBe("line 1\nline 2\nline 3");
  });

  test("evicts oldest lines once the byte cap is exceeded", () => {
    const proc = newProcess();
    // Each line is ~1 KB; a handful exceeds the ~4 KB cap and forces eviction
    // of the earliest lines while preserving newest-line ordering.
    const kb = "x".repeat(1024);
    for (let i = 0; i < 8; i++) {
      feed(proc, `${i}:${kb}`);
    }

    const retained = proc.stderrSince(0).split("\n");
    // Oldest ("0:") evicted, newest ("7:") retained, still in insertion order.
    expect(retained.at(0)).not.toContain("0:");
    expect(retained.at(-1)).toContain("7:");
    expect(Buffer.byteLength(proc.stderrSince(0))).toBeLessThanOrEqual(
      4096 + kb.length,
    );

    const indices = retained.map((l) => Number(l.split(":")[0]));
    const sorted = [...indices].sort((a, b) => a - b);
    expect(indices).toEqual(sorted);
  });

  test("truncates an oversized line to the cap, keeping its tail (the diagnostic)", () => {
    const proc = newProcess();
    // The real adapter error sits at the END of the chunk; deriveFailureError
    // reads from the tail, so truncation must drop the head, not the tail.
    const huge = "H".repeat(6000) + "TAIL_DIAGNOSTIC";
    feed(proc, huge);

    const retained = proc.stderrSince(0);
    expect(retained.length).toBe(4096);
    expect(retained.endsWith("TAIL_DIAGNOSTIC")).toBe(true);
  });

  test("stderrSince(0) is pure: repeated reads do not clear the buffer", () => {
    const proc = newProcess();
    feed(proc, "only line");

    expect(proc.stderrSince(0)).toBe("only line");
    expect(proc.stderrSince(0)).toBe("only line");
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

// ---------------------------------------------------------------------------
// createSession: structured auth_required handling through the real retry path
// ---------------------------------------------------------------------------

/**
 * Wires a process with a fake protocol connection and advertised auth methods,
 * following the same no-child-process injection style as `feed` above. The
 * retry logic under test (`withAuthRetry`, method selection, the typed throw)
 * runs for real.
 */
function wireProcess(opts: {
  authMethods: unknown[];
  newSession: () => Promise<unknown>;
  env?: Record<string, string>;
}): { proc: AcpAgentProcess; authenticateCalls: () => number } {
  const proc = new AcpAgentProcess("test-agent", config, clientFactory);
  let authed = 0;
  (proc as unknown as { connection: unknown }).connection = {
    newSession: opts.newSession,
    authenticate: async () => {
      authed += 1;
      return {};
    },
  };
  (proc as unknown as { initializeResponse: unknown }).initializeResponse = {
    authMethods: opts.authMethods,
  };
  (proc as unknown as { spawnedEnv: unknown }).spawnedEnv = opts.env ?? {};
  return { proc, authenticateCalls: () => authed };
}

const TERMINAL_ONLY_METHODS = [
  { id: "claude-ai-login", name: "Claude Subscription", type: "terminal" },
];

describe("AcpAgentProcess.createSession auth_required handling", () => {
  test("a structured auth_required rejection with only terminal methods becomes AcpAuthRequiredError", async () => {
    // The wire shape the adapter actually sends: a plain JSON-RPC error
    // object, not an Error subclass. With no satisfiable env_var method the
    // retry path must surface the typed error the session manager and the
    // spawn tool classify on; losing the type here silently degrades the
    // whole recovery surface back into a generic failure.
    const { proc } = wireProcess({
      authMethods: TERMINAL_ONLY_METHODS,
      newSession: () =>
        Promise.reject({ code: -32000, message: "Authentication required" }),
    });

    const err: unknown = await proc.createSession("/tmp").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(AcpAuthRequiredError);
    expect((err as AcpAuthRequiredError).agentId).toBe("test-agent");
    expect(isAcpAuthRequired(err)).toBe(true);
  });

  test("a satisfiable env_var method authenticates and retries instead of throwing", async () => {
    let calls = 0;
    const { proc, authenticateCalls } = wireProcess({
      authMethods: [
        {
          id: "api-key",
          name: "Use SOME_KEY",
          type: "env_var",
          vars: [{ name: "SOME_KEY" }],
        },
      ],
      env: { SOME_KEY: "value" },
      newSession: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject({ code: -32000, message: "Authentication required" })
          : Promise.resolve({ sessionId: "session-1" });
      },
    });

    await expect(proc.createSession("/tmp")).resolves.toBe("session-1");
    expect(authenticateCalls()).toBe(1);
  });

  test("a non-auth rejection passes through untyped", async () => {
    const { proc } = wireProcess({
      authMethods: TERMINAL_ONLY_METHODS,
      newSession: () =>
        Promise.reject({ code: -32603, message: "Internal error" }),
    });

    const err: unknown = await proc.createSession("/tmp").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).not.toBeInstanceOf(AcpAuthRequiredError);
    expect(isAcpAuthRequired(err)).toBe(false);
  });
});
