import { describe, expect, test } from "bun:test";

import {
  createWorkflowSandbox,
  WorkflowResourceError,
  WorkflowScriptError,
} from "./sandbox.js";

// Workflow scripts are SYNCHRONOUS: host functions block the script via
// asyncify (the VM stack unwinds while the host promise settles, then resumes),
// so authors call `agent(...)` and get the value back directly — no `await`.
describe("createWorkflowSandbox — functional", () => {
  test("async host function round-trips through the VM (asyncify suspends)", async () => {
    const calls: unknown[][] = [];
    const sandbox = createWorkflowSandbox({
      hostFunctions: {
        agent: async (...args: unknown[]) => {
          calls.push(args);
          await new Promise((r) => setTimeout(r, 5));
          return { reply: `handled:${String(args[0])}` };
        },
      },
    });

    const result = await sandbox.run(
      `const r = agent("hello", 42);
       return r.reply + "!";`,
      null,
    );

    expect(result).toBe("handled:hello!");
    expect(calls).toEqual([["hello", 42]]);
  });

  test("multiple sequential async host calls preserve ordering", async () => {
    const sandbox = createWorkflowSandbox({
      hostFunctions: {
        step: async (n: unknown) => {
          await new Promise((r) => setTimeout(r, 1));
          return (n as number) * 2;
        },
      },
    });

    const result = await sandbox.run(
      `let total = 0;
       for (let i = 1; i <= 3; i++) { total += step(i); }
       return total;`,
      null,
    );

    expect(result).toBe(12); // (1+2+3)*2
  });

  test("synchronous host function works", async () => {
    const sandbox = createWorkflowSandbox({
      hostFunctions: { double: (n: unknown) => (n as number) * 2 },
    });
    const result = await sandbox.run(`return double(21);`, null);
    expect(result).toBe(42);
  });

  test("TypeScript source is transpiled and runs", async () => {
    const sandbox = createWorkflowSandbox({ hostFunctions: {} });
    const result = await sandbox.run(
      `interface Point { x: number; y: number }
       const p: Point = { x: 3, y: 4 };
       const dist: number = Math.sqrt(p.x ** 2 + p.y ** 2);
       return dist;`,
      null,
    );
    expect(result).toBe(5);
  });

  test("args arrive intact (nested object)", async () => {
    const sandbox = createWorkflowSandbox({ hostFunctions: {} });
    const result = await sandbox.run(
      `return { sum: args.values.reduce((a, b) => a + b, 0), name: args.name };`,
      { values: [1, 2, 3, 4], name: "Alice" },
    );
    expect(result).toEqual({ sum: 10, name: "Alice" });
  });

  test("script exceptions propagate as WorkflowScriptError with QuickJS stack", async () => {
    const sandbox = createWorkflowSandbox({ hostFunctions: {} });
    let caught: unknown;
    try {
      await sandbox.run(
        `function boom() { throw new Error("kaboom"); }
         boom();`,
        null,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WorkflowScriptError);
    const err = caught as WorkflowScriptError;
    expect(err.message).toContain("kaboom");
    expect(err.scriptStack).toBeDefined();
    expect(err.scriptStack).toContain("boom");
  });

  test("host function args marshal as JSON (nested values intact)", async () => {
    let received: unknown[] | undefined;
    const sandbox = createWorkflowSandbox({
      hostFunctions: {
        capture: (...args: unknown[]) => {
          received = args;
          return "ok";
        },
      },
    });
    await sandbox.run(
      `capture({ nested: [1, { a: true }] }, "str", 99);`,
      null,
    );
    expect(received).toEqual([{ nested: [1, { a: true }] }, "str", 99]);
  });

  test("host function returning undefined yields undefined in the script", async () => {
    const sandbox = createWorkflowSandbox({
      hostFunctions: { noop: () => undefined },
    });
    const result = await sandbox.run(
      `return noop() === undefined ? "undef" : "defined";`,
      null,
    );
    expect(result).toBe("undef");
  });

  test("onLog receives console output", async () => {
    const logs: string[] = [];
    const sandbox = createWorkflowSandbox({
      hostFunctions: {},
      onLog: (m) => logs.push(m),
    });
    await sandbox.run(`console.log("hi", { a: 1 });`, null);
    expect(logs).toEqual(['hi {"a":1}']);
  });

  test("the same sandbox can run multiple scripts (fresh isolation each run)", async () => {
    const sandbox = createWorkflowSandbox({ hostFunctions: {} });
    await sandbox.run(`globalThis.leaked = "first";`, null);
    const result = await sandbox.run(`return typeof globalThis.leaked;`, null);
    expect(result).toBe("undefined");
  });
});

// Workflow scripts must be deterministic so journaled resume replays identically
// between the original run and a resume. Wall-clock and entropy are banned.
describe("createWorkflowSandbox — determinism bans", () => {
  const banned = async (script: string): Promise<void> => {
    const sandbox = createWorkflowSandbox({ hostFunctions: {} });
    await expect(sandbox.run(script, null)).rejects.toThrow(
      /non-deterministic|new Date/,
    );
  };

  test("Date.now() is banned", () => banned(`return Date.now();`));
  test("new Date() is banned", () => banned(`return new Date().getTime();`));
  test("Math.random() is banned", () => banned(`return Math.random();`));

  test("new Date() cannot be reached via Date.prototype.constructor", () =>
    // The wrapper shares RealDate.prototype; if its `constructor` still pointed
    // at the original Date, this would bypass the ban and read wall-clock time.
    banned(`return new (Date.prototype.constructor)().getTime();`));

  test("an instance's .constructor is the banned wrapper (no escape)", () =>
    // `new Date(args)` returns a RealDate whose prototype is the shared object,
    // so `inst.constructor` must resolve to the banned wrapper, not the original.
    banned(
      `const d = new Date(1577836800000); return new (d.constructor)().getTime();`,
    ));

  test("new Date(timestamp) still works and stays instanceof Date", async () => {
    const sandbox = createWorkflowSandbox({ hostFunctions: {} });
    const result = await sandbox.run(
      `const d = new Date(1577836800000);
       return [d instanceof Date, d.getUTCFullYear()];`,
      null,
    );
    // 1577836800000 = 2020-01-01T00:00:00Z. The explicit-arg path is allowed
    // (deterministic); only the zero-arg wall-clock read is banned.
    expect(result).toEqual([true, 2020]);
  });
});

// The interrupt deadline must bound script CPU even when the script loops over
// host calls — a cheap host call must NOT reset the deadline, or the guard is
// trivially evaded.
describe("createWorkflowSandbox — CPU guard", () => {
  test("a tight loop over a cheap host fn trips the interrupt deadline", async () => {
    // `cheap()` returns instantly, so it must not reset the CPU deadline —
    // otherwise this loop would refresh the guard every iteration and pin the
    // run forever. With a short deadline it trips promptly.
    const sandbox = createWorkflowSandbox({
      hostFunctions: { cheap: () => 1 },
      interruptDeadlineMs: 100,
    });
    await expect(
      sandbox.run(`while (true) { cheap(); }`, null),
    ).rejects.toThrow(WorkflowResourceError);
  });

  test("a genuinely long host call does not trip the deadline (latency excused)", async () => {
    // A single host call whose await (1000ms) far exceeds the deadline (200ms)
    // must NOT trip: the reset excuses real leaf/agent latency. With the reset
    // gated on a 50ms threshold, this 1000ms call still resets.
    const sandbox = createWorkflowSandbox({
      hostFunctions: {
        slow: async () => {
          await new Promise((r) => setTimeout(r, 1000));
          return "ok";
        },
      },
      interruptDeadlineMs: 200,
    });
    const result = await sandbox.run(`return slow();`, null);
    expect(result).toBe("ok");
  });

  test("a host call that REJECTS after a long await still resets the deadline (catch survives)", async () => {
    // A leaf that fails after a multi-second round-trip must not leave the
    // script's catch block resuming against an already-expired CPU deadline.
    // The reject-path reset (finally) excuses the awaited latency on failure
    // too, so the catch — which does enough work to hit an interrupt check —
    // runs instead of being killed as a WorkflowResourceError. Without the
    // reset, this run rejects.
    const sandbox = createWorkflowSandbox({
      hostFunctions: {
        slowFail: async () => {
          await new Promise((r) => setTimeout(r, 1000));
          throw new Error("leaf failed");
        },
      },
      interruptDeadlineMs: 300,
    });
    const result = await sandbox.run(
      `try {
         slowFail();
         return "no-throw";
       } catch (e) {
         let s = 0;
         for (let i = 0; i < 100000; i++) s += i;
         return "caught:" + s;
       }`,
      null,
    );
    expect(String(result).startsWith("caught:")).toBe(true);
  });
});
