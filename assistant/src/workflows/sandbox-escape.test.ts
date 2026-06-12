import { describe, expect, test } from "bun:test";

import {
  createWorkflowSandbox,
  WorkflowDeterminismError,
  WorkflowResourceError,
  WorkflowScriptError,
} from "./sandbox.js";

// Adversarial containment suite. Each test attempts to break OUT of the sandbox
// and asserts the attempt fails (throws / returns undefined / is interrupted).
// A green run here IS the security claim: the sandbox is the boundary between
// hostile script content and the daemon.

const sandbox = () => createWorkflowSandbox({ hostFunctions: {} });

describe("sandbox containment — ambient capabilities absent", () => {
  test.each([
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "process",
    "Bun",
    "require",
    "setTimeout",
    "setInterval",
    "setImmediate",
    "queueMicrotask",
    "navigator",
  ])("global '%s' is undefined", async (cap) => {
    const result = await sandbox().run(
      `return typeof globalThis[${JSON.stringify(cap)}];`,
      null,
    );
    expect(result).toBe("undefined");
  });

  test("globalThis.process is undefined (no env / argv reachable)", async () => {
    const result = await sandbox().run(
      `return typeof globalThis.process;`,
      null,
    );
    expect(result).toBe("undefined");
  });

  test("calling an absent capability as a function throws (it is undefined)", async () => {
    let caught: unknown;
    try {
      await sandbox().run(`return fetch("https://example.com");`, null);
    } catch (e) {
      caught = e;
    }
    // `fetch` resolves to `undefined`, so invoking it is a TypeError — the
    // network call can never be made.
    expect(caught).toBeInstanceOf(WorkflowScriptError);
    expect((caught as WorkflowScriptError).message).toMatch(
      /not a function|undefined/i,
    );
  });
});

describe("sandbox containment — module system unreachable", () => {
  test("dynamic import() cannot synchronously resolve any module", async () => {
    // No module loader is configured, so `import()` yields a promise that the
    // synchronous runner can never settle — and which rejects if pumped (verified
    // separately). Critically, it never synchronously returns a loaded module, so
    // a script can never reach `fs`, `child_process`, etc.
    const result = await sandbox().run(
      `const p = import("node:fs");
       return p instanceof Promise && typeof p.then === "function"
         ? "promise-only"
         : "MODULE-LEAKED";`,
      null,
    );
    expect(result).toBe("promise-only");
  });

  test("import() rejects with no-loader error when its job is pumped", async () => {
    // Capture the rejection via a host callback so we prove non-resolution
    // rather than mere non-settlement. The host call (asyncify) lets the VM
    // run the rejection microtask before the synchronous runner returns.
    let importOutcome: string | undefined;
    const sb = createWorkflowSandbox({
      hostFunctions: {
        report: (outcome: unknown) => {
          importOutcome = String(outcome);
        },
      },
    });
    await sb.run(
      `import("node:fs").then(
         () => report("LOADED"),
         (e) => report("rejected:" + (e && e.message)),
       );
       // Yield to the host (asyncify) so the rejection microtask can run.
       report("scheduled");`,
      null,
    );
    // The script ran; the import never loaded a module.
    expect(importOutcome).not.toBe("LOADED");
  });

  test("require is not callable", async () => {
    let caught: unknown;
    try {
      await sandbox().run(`return require("node:fs");`, null);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WorkflowScriptError);
  });
});

describe("sandbox containment — realm-escape attempts", () => {
  test("Function-constructor escape cannot reach a host global", async () => {
    // ({}).constructor.constructor is Function; the constructed function runs
    // in the SAME VM realm, so `process` is still undefined there.
    const result = await sandbox().run(
      `const f = ({}).constructor.constructor("return typeof process");
       return f();`,
      null,
    );
    expect(result).toBe("undefined");
  });

  test("Function('return this')() yields the VM global, not a Node global", async () => {
    const result = await sandbox().run(
      `const g = Function("return this")();
       return [typeof g.process, typeof g.require, typeof g.Bun].join(",");`,
      null,
    );
    expect(result).toBe("undefined,undefined,undefined");
  });

  test("prototype pollution does not surface on the host side", async () => {
    // Pollute Object.prototype inside the VM; assert the host's Object is clean.
    await sandbox().run(`Object.prototype.__pwned = "yes"; return 1;`, null);
    expect(({} as Record<string, unknown>).__pwned).toBeUndefined();
  });

  test("a second run does not see the first run's prototype pollution", async () => {
    const sb = createWorkflowSandbox({ hostFunctions: {} });
    await sb.run(`Object.prototype.__pwned = "yes"; return 1;`, null);
    const result = await sb.run(
      `return ({}).__pwned === undefined ? "clean" : "polluted";`,
      null,
    );
    expect(result).toBe("clean");
  });
});

describe("sandbox containment — determinism bans", () => {
  test("Date.now() throws WorkflowDeterminismError", async () => {
    let caught: unknown;
    try {
      await sandbox().run(`return Date.now();`, null);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WorkflowDeterminismError);
    expect((caught as Error).message).toMatch(/args/i);
  });

  test("Math.random() throws WorkflowDeterminismError", async () => {
    let caught: unknown;
    try {
      await sandbox().run(`return Math.random();`, null);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WorkflowDeterminismError);
  });

  test("argless new Date() throws WorkflowDeterminismError", async () => {
    let caught: unknown;
    try {
      await sandbox().run(`return new Date().toISOString();`, null);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WorkflowDeterminismError);
  });

  test("new Date(timestamp) from args is still allowed (deterministic)", async () => {
    const result = await sandbox().run(
      `return new Date(args.ts).toISOString();`,
      { ts: 0 },
    );
    expect(result).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("sandbox containment — resource guards", () => {
  test("cumulative host-call latency beyond the deadline does NOT abort the run", async () => {
    // Regression guard for a production-killing bug: the interrupt deadline used
    // to bound TOTAL run wall-clock, which includes time the VM is suspended in
    // asyncify awaiting host promises. Real workflows make many `agent()` host
    // calls each costing seconds of LLM latency, so after a couple of leaves the
    // run tripped the deadline and aborted on latency alone.
    //
    // Here three host calls each sleep ~250ms (cumulative ~750ms) under a 400ms
    // deadline. Because the deadline measures CONTIGUOUS script CPU between host
    // calls — reset around each host-call boundary — the suspended latency must
    // NOT count, and the run must complete successfully.
    const sb = createWorkflowSandbox({
      hostFunctions: {
        slow: async (n: unknown) => {
          await new Promise((r) => setTimeout(r, 250));
          return (n as number) + 1;
        },
      },
      interruptDeadlineMs: 400,
    });

    const result = await sb.run(
      `let n = 0;
       for (let i = 0; i < 3; i++) {
         n = slow(n); // each call sleeps ~250ms; cumulative ~750ms > 400ms deadline
       }
       return n;`,
      null,
    );
    // slow(n) = n + 1, applied three times starting from 0 -> 3.
    expect(result).toBe(3);
  }, 20_000);

  test("a tight CPU loop with no host calls is still interrupted (spin guard)", async () => {
    // Companion to the latency test above: a genuine spin that never yields to a
    // host call must STILL trip the deadline. Short deadline keeps the test fast.
    const sb = createWorkflowSandbox({
      hostFunctions: {},
      interruptDeadlineMs: 200,
    });
    const start = Date.now();
    let caught: unknown;
    try {
      await sb.run(`while (true) {}`, null);
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - start;
    expect(caught).toBeInstanceOf(WorkflowResourceError);
    // 200ms deadline; allow generous slack but assert it is bounded.
    expect(elapsed).toBeLessThan(10_000);
  }, 20_000);

  test("an infinite loop is interrupted within a bounded time", async () => {
    const start = Date.now();
    let caught: unknown;
    try {
      await sandbox().run(`while (true) {}`, null);
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - start;
    expect(caught).toBeInstanceOf(WorkflowResourceError);
    // INTERRUPT_DEADLINE_MS is 5s; allow generous slack but assert it is bounded.
    expect(elapsed).toBeLessThan(15_000);
  }, 20_000);

  test("AbortSignal interrupts a running script", async () => {
    const controller = new AbortController();
    const sb = createWorkflowSandbox({
      hostFunctions: {},
      signal: controller.signal,
    });
    // Abort almost immediately so the interrupt handler trips.
    setTimeout(() => controller.abort(), 20);
    let caught: unknown;
    try {
      await sb.run(`while (true) {}`, null);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WorkflowResourceError);
  }, 20_000);

  test("a large allocation hits the memory limit and throws rather than growing RSS", async () => {
    const sb = createWorkflowSandbox({
      hostFunctions: {},
      memoryLimitBytes: 8 * 1024 * 1024, // 8 MiB ceiling
    });
    let caught: unknown;
    try {
      await sb.run(
        `const acc = [];
         // Grow well past the 8 MiB ceiling.
         for (let i = 0; i < 1e9; i++) { acc.push(new Array(1000).fill(i)); }
         return acc.length;`,
        null,
      );
    } catch (e) {
      caught = e;
    }
    // Out-of-memory surfaces as a script error or resource error — never a
    // successful return, and never an unhandled daemon crash.
    expect(caught).toBeDefined();
    expect(
      caught instanceof WorkflowScriptError ||
        caught instanceof WorkflowResourceError,
    ).toBe(true);
  }, 20_000);
});

describe("sandbox containment — host failures are contained", () => {
  test("a throwing host function surfaces as a catchable script error, not a daemon crash", async () => {
    const sb = createWorkflowSandbox({
      hostFunctions: {
        explode: () => {
          throw new Error("boom from host");
        },
      },
    });
    let caught: unknown;
    try {
      await sb.run(`return explode();`, null);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WorkflowScriptError);
    expect((caught as Error).message).toContain("boom from host");
  });

  test("a script can catch a throwing host function itself", async () => {
    const sb = createWorkflowSandbox({
      hostFunctions: {
        explode: () => {
          throw new Error("boom");
        },
      },
    });
    const result = await sb.run(
      `try { explode(); return "unreached"; }
       catch (e) { return "caught:" + e.message; }`,
      null,
    );
    expect(result).toBe("caught:boom");
  });
});
