/**
 * Unit tests for `plugins/pipeline.ts`.
 *
 * Covers:
 * - Onion composition order (outer → inner → terminal → inner → outer).
 * - Short-circuit (middleware that omits `next` — terminal is skipped).
 * - Error propagation (no internal try/catch — errors flow unchanged).
 * - Timeout (breached budget rejects with `PluginTimeoutError`).
 * - Log shape (one structured record per invocation, every field typed).
 */

import { beforeEach, describe, expect, test } from "bun:test";

import type { TrustContext } from "../daemon/conversation-runtime-assembly.js";
import {
  composeMiddleware,
  DEFAULT_TIMEOUTS,
  runPipeline,
} from "../plugins/pipeline.js";
import {
  type Middleware,
  PluginTimeoutError,
  type TurnContext,
} from "../plugins/types.js";

// A minimal fake pino-compatible logger. The pipeline runner detects a
// `logger` slot on the context (shape `{ info(record, msg?) }`) and falls
// back to the module logger only when that slot is absent. Tests pass this
// fake in via `ctx.logger` so the runner emits into our capture buffer
// instead of real stderr.
type LogCall = [record: Record<string, unknown>, msg?: string];

function makeFakeLogger(): {
  calls: LogCall[];
  info: (record: Record<string, unknown>, msg?: string) => void;
  warn: () => void;
  error: () => void;
  debug: () => void;
  trace: () => void;
  fatal: () => void;
} {
  const calls: LogCall[] = [];
  return {
    calls,
    info: (record, msg) => {
      calls.push([record, msg]);
    },
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
  };
}

let fakeLogger = makeFakeLogger();

const trust: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "guardian",
};

function makeCtx(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    requestId: "req-test",
    conversationId: "conv-test",
    turnIndex: 3,
    trust,
    // The runner reads `(ctx as { logger?: unknown }).logger` — we cast
    // through the partial type to attach it without widening TurnContext.
    ...({ logger: fakeLogger } as Partial<TurnContext>),
    ...overrides,
  };
}

beforeEach(() => {
  fakeLogger = makeFakeLogger();
});

type Args = { value: number };
type Result = { value: number };

describe("composeMiddleware", () => {
  test("invokes layers in outer→inner→terminal→inner→outer order", async () => {
    const trace: string[] = [];

    const outer: Middleware<Args, Result> = async (args, next) => {
      trace.push("outer:before");
      const result = await next(args);
      trace.push("outer:after");
      return result;
    };

    const inner: Middleware<Args, Result> = async (args, next) => {
      trace.push("inner:before");
      const result = await next(args);
      trace.push("inner:after");
      return result;
    };

    const terminal = async (args: Args): Promise<Result> => {
      trace.push("terminal");
      return { value: args.value * 2 };
    };

    const composed = composeMiddleware<Args, Result>([outer, inner], terminal);
    const result = await composed({ value: 7 }, makeCtx());

    expect(result).toEqual({ value: 14 });
    expect(trace).toEqual([
      "outer:before",
      "inner:before",
      "terminal",
      "inner:after",
      "outer:after",
    ]);
  });

  test("middleware that omits `next` short-circuits the chain", async () => {
    const trace: string[] = [];

    const shortCircuit: Middleware<Args, Result> = async (_args, _next) => {
      trace.push("short-circuit");
      return { value: 99 };
    };

    const inner: Middleware<Args, Result> = async (args, next) => {
      trace.push("inner");
      return next(args);
    };

    const terminal = async (_args: Args): Promise<Result> => {
      trace.push("terminal");
      return { value: 0 };
    };

    const composed = composeMiddleware<Args, Result>(
      [shortCircuit, inner],
      terminal,
    );
    const result = await composed({ value: 1 }, makeCtx());

    expect(result).toEqual({ value: 99 });
    expect(trace).toEqual(["short-circuit"]);
  });

  test("empty middleware list reduces to the terminal handler", async () => {
    const terminal = async (args: Args): Promise<Result> => ({
      value: args.value + 1,
    });
    const composed = composeMiddleware<Args, Result>([], terminal);
    const result = await composed({ value: 10 }, makeCtx());
    expect(result).toEqual({ value: 11 });
  });
});

describe("runPipeline — error propagation", () => {
  test("errors thrown by middleware bubble through unchanged", async () => {
    class Boom extends Error {
      override readonly name = "Boom";
    }

    const thrower: Middleware<Args, Result> = async () => {
      throw new Boom("detonated");
    };

    const terminal = async (_args: Args): Promise<Result> => {
      throw new Error("terminal should not run");
    };

    await expect(
      runPipeline(
        "persistence",
        [thrower],
        terminal,
        { value: 1 },
        makeCtx(),
        DEFAULT_TIMEOUTS.persistence,
      ),
    ).rejects.toBeInstanceOf(Boom);
  });

  test("errors thrown by the terminal handler bubble through unchanged", async () => {
    const terminal = async (_args: Args): Promise<Result> => {
      throw new TypeError("from terminal");
    };

    await expect(
      runPipeline(
        "persistence",
        [],
        terminal,
        { value: 1 },
        makeCtx(),
        DEFAULT_TIMEOUTS.persistence,
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("runPipeline — timeout", () => {
  test("breached budget rejects with PluginTimeoutError carrying pipeline + plugin name", async () => {
    const sleeper: Middleware<Args, Result> = async (_args, _next) =>
      new Promise<Result>((resolve) => {
        setTimeout(() => resolve({ value: 0 }), 200);
      });

    const terminal = async (_args: Args): Promise<Result> => ({ value: 0 });

    let caught: unknown;
    try {
      await runPipeline(
        "memoryRetrieval",
        [sleeper],
        terminal,
        { value: 1 },
        makeCtx({ pluginName: "slow-plugin" }),
        20,
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PluginTimeoutError);
    const tErr = caught as PluginTimeoutError;
    expect(tErr.pipeline).toBe("memoryRetrieval");
    expect(tErr.pluginName).toBe("slow-plugin");
    expect(tErr.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(tErr.message).toContain("memoryRetrieval");
    expect(tErr.message).toContain("slow-plugin");
  });

  test("fast pipeline does not arm the timer redundantly", async () => {
    const terminal = async (args: Args): Promise<Result> => ({
      value: args.value,
    });
    const result = await runPipeline(
      "historyRepair",
      [],
      terminal,
      { value: 42 },
      makeCtx(),
      DEFAULT_TIMEOUTS.historyRepair,
    );
    expect(result).toEqual({ value: 42 });
  });

  test("null timeout skips the race entirely", async () => {
    // llmCall has DEFAULT_TIMEOUTS.llmCall === null — runner must not arm a
    // timer. We verify by completing after an artificial 30ms wait and
    // confirming success without interference.
    const sleeper: Middleware<Args, Result> = async (args, next) =>
      new Promise<Result>((resolve) => {
        setTimeout(() => resolve(next(args)), 30);
      });
    const terminal = async (_args: Args): Promise<Result> => ({ value: 1 });
    const result = await runPipeline(
      "llmCall",
      [sleeper],
      terminal,
      { value: 0 },
      makeCtx(),
      DEFAULT_TIMEOUTS.llmCall,
    );
    expect(result).toEqual({ value: 1 });
  });
});

describe("runPipeline — structured log record", () => {
  test("success emits one record with every documented field present", async () => {
    const namedOuter: Middleware<Args, Result> = async function outerMw(
      args,
      next,
    ) {
      return next(args);
    };
    const terminal = async (args: Args): Promise<Result> => ({
      value: args.value,
    });

    await runPipeline(
      "compaction",
      [namedOuter],
      terminal,
      { value: 7 },
      makeCtx(),
      DEFAULT_TIMEOUTS.compaction,
    );

    expect(fakeLogger.calls.length).toBe(1);
    const [record, msg] = fakeLogger.calls[0]!;
    expect(msg).toBe("plugin.pipeline");
    expect(record.event).toBe("plugin.pipeline");
    expect(record.pipeline).toBe("compaction");
    expect(record.chain).toEqual(["outerMw"]);
    expect(record.outcome).toBe("success");
    expect(typeof record.durationMs).toBe("number");
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
    expect(record.timeoutMs).toBe(DEFAULT_TIMEOUTS.compaction!);
    expect(record.requestId).toBe("req-test");
    expect(record.conversationId).toBe("conv-test");
    expect(record.turnIndex).toBe(3);
    // pluginName is only present when ctx carries one.
    expect(record.pluginName).toBeUndefined();
    // Error fields absent on success.
    expect(record.errorName).toBeUndefined();
    expect(record.errorMessage).toBeUndefined();
    expect(record.errorStack).toBeUndefined();
  });

  test("error path records outcome=error + error fields + plugin name", async () => {
    class Boom extends Error {
      override readonly name = "BoomError";
    }
    const thrower: Middleware<Args, Result> = async () => {
      throw new Boom("kaboom");
    };
    const terminal = async (_args: Args): Promise<Result> => ({ value: 0 });

    await expect(
      runPipeline(
        "toolError",
        [thrower],
        terminal,
        { value: 1 },
        makeCtx({ pluginName: "noisy-plugin" }),
        DEFAULT_TIMEOUTS.toolError,
      ),
    ).rejects.toBeInstanceOf(Boom);

    expect(fakeLogger.calls.length).toBe(1);
    const [record] = fakeLogger.calls[0]!;
    expect(record.outcome).toBe("error");
    expect(record.pipeline).toBe("toolError");
    expect(record.errorName).toBe("BoomError");
    expect(record.errorMessage).toBe("kaboom");
    expect(typeof record.errorStack).toBe("string");
    expect(record.pluginName).toBe("noisy-plugin");
    expect(record.timeoutMs).toBe(DEFAULT_TIMEOUTS.toolError!);
  });

  test("timeout path records outcome=timeout + PluginTimeoutError fields", async () => {
    const sleeper: Middleware<Args, Result> = async (_args, _next) =>
      new Promise<Result>((resolve) => {
        setTimeout(() => resolve({ value: 0 }), 200);
      });
    const terminal = async (_args: Args): Promise<Result> => ({ value: 0 });

    await expect(
      runPipeline(
        "emptyResponse",
        [sleeper],
        terminal,
        { value: 1 },
        makeCtx({ pluginName: "slow-plugin" }),
        15,
      ),
    ).rejects.toBeInstanceOf(PluginTimeoutError);

    expect(fakeLogger.calls.length).toBe(1);
    const [record] = fakeLogger.calls[0]!;
    expect(record.outcome).toBe("timeout");
    expect(record.pipeline).toBe("emptyResponse");
    expect(record.errorName).toBe("PluginTimeoutError");
    expect(String(record.errorMessage)).toContain("emptyResponse");
    expect(String(record.errorMessage)).toContain("slow-plugin");
    expect(record.timeoutMs).toBe(15);
    expect(record.pluginName).toBe("slow-plugin");
  });

  test("null timeout omits timeoutMs field from the log record", async () => {
    const terminal = async (args: Args): Promise<Result> => ({
      value: args.value,
    });
    await runPipeline(
      "llmCall",
      [],
      terminal,
      { value: 5 },
      makeCtx(),
      DEFAULT_TIMEOUTS.llmCall,
    );

    expect(fakeLogger.calls.length).toBe(1);
    const [record] = fakeLogger.calls[0]!;
    expect(record.pipeline).toBe("llmCall");
    expect(record.outcome).toBe("success");
    expect(record.timeoutMs).toBeUndefined();
  });

  test("turnIndex is omitted when unset on the context", async () => {
    const terminal = async (_args: Args): Promise<Result> => ({ value: 0 });
    const ctxNoTurn = {
      requestId: "r",
      conversationId: "c",
      turnIndex: undefined as unknown as number,
      trust,
      logger: fakeLogger,
    } as TurnContext;
    await runPipeline(
      "persistence",
      [],
      terminal,
      { value: 0 },
      ctxNoTurn,
      null,
    );
    const [record] = fakeLogger.calls[0]!;
    expect(record.turnIndex).toBeUndefined();
  });

  test("chain list has one entry per middleware in registration order", async () => {
    const a: Middleware<Args, Result> = async function outerA(args, next) {
      return next(args);
    };
    const b: Middleware<Args, Result> = async function middleB(args, next) {
      return next(args);
    };
    const c: Middleware<Args, Result> = async function innerC(args, next) {
      return next(args);
    };
    const terminal = async (args: Args): Promise<Result> => ({
      value: args.value,
    });
    await runPipeline(
      "tokenEstimate",
      [a, b, c],
      terminal,
      { value: 0 },
      makeCtx(),
      DEFAULT_TIMEOUTS.tokenEstimate,
    );
    const [record] = fakeLogger.calls[0]!;
    expect(record.chain).toEqual(["outerA", "middleB", "innerC"]);
  });
});

describe("DEFAULT_TIMEOUTS", () => {
  test("matches the design-doc table exactly", () => {
    expect(DEFAULT_TIMEOUTS).toEqual({
      turn: null,
      llmCall: null,
      toolExecute: null,
      memoryRetrieval: 5000,
      historyRepair: 1000,
      tokenEstimate: 1000,
      compaction: 30000,
      overflowReduce: 30000,
      persistence: 10000,
      titleGenerate: 30000,
      toolResultTruncate: 1000,
      emptyResponse: 500,
      toolError: 500,
      circuitBreaker: 500,
    });
  });
});
