/**
 * Tests for the live-shadow `memoryRetrieval` middleware
 * (`assistant/src/memory/v3/shadow-middleware.ts`).
 *
 * The critical invariant this PR guarantees: with `memory.v3.shadow` off
 * (the default), the middleware is a byte-for-byte pass-through — it returns
 * the downstream `MemoryResult` unchanged, never calls the v3 loop, and never
 * writes a log row. With the flag on, it runs the v3 loop alongside the
 * default path, logs v3's selection as `mode='v3_shadow'`, and STILL returns
 * the unchanged downstream result (v2 injected, never v3). A v3 failure is
 * swallowed and the turn result is unaffected.
 *
 * Everything the middleware reaches (config, the v3 loop, the activation-log
 * store, message/now/everInjected reads) is stubbed via `mock.module` — no
 * real LLM, no real workspace DB.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "../../../__tests__/helpers/mock-logger.js";
import type { AssistantConfig } from "../../../config/schema.js";
import type { TrustContext } from "../../../daemon/trust-context.js";
import type {
  MemoryArgs,
  MemoryResult,
  TurnContext,
} from "../../../plugins/types.js";
import type { RecordMemoryV2ActivationLogParams } from "../../memory-v2-activation-log-store.js";
import type {
  RetrievalInput,
  RetrievalOutput,
} from "../../v2/harness/retriever.js";

mock.module("../../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

// ── Mutable test doubles, rewired per test ───────────────────────────────

/** Drives `config.memory.v3.{enabled,shadow}` and `historical_pairs`. */
let v3Enabled = false;
let v3Shadow = false;
/** When false, omit the `memory.v3` block entirely (mirrors configs built
 * outside the Zod schema, e.g. agent-loop test fixtures). */
let v3Present = true;

function makeConfig(): AssistantConfig {
  return {
    memory: {
      v2: { router: { historical_pairs: 1 } },
      ...(v3Present ? { v3: { enabled: v3Enabled, shadow: v3Shadow } } : {}),
    },
  } as unknown as AssistantConfig;
}

/** Captured `runRetrievalLoop` invocations. */
const loopCalls: Array<{ input: RetrievalInput }> = [];
/** Behavior of the stubbed loop — overridden per test. */
let loopImpl: (
  input: RetrievalInput,
) => Promise<RetrievalOutput> = async () => ({
  selectedSlugs: [],
  sourceBySlug: new Map(),
  trace: { passes: [] },
  cost: { ms: 0 },
  failureReason: null,
});

/** Captured `recordMemoryV2ActivationLog` calls. */
const logCalls: RecordMemoryV2ActivationLogParams[] = [];

mock.module("../../../config/loader.js", () => ({
  getConfig: () => makeConfig(),
}));
mock.module("../../../util/platform.js", () => ({
  getWorkspaceDir: () => "/tmp/shadow-test-workspace",
}));
// Chainable drizzle-query stub: every builder method returns the same object
// and `.all()` yields the seeded rows. The shadow middleware reads recent
// messages via `db.select(...).from(...).where(...).orderBy(...).limit(...).all()`.
const messageRows: Array<{ role: string; content: string }> = [
  {
    role: "user",
    content: JSON.stringify([{ type: "text", text: "hello memory" }]),
  },
];
function makeFakeDb(): never {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "from", "where", "orderBy", "limit"]) {
    builder[m] = () => builder;
  }
  builder.all = () => messageRows.slice();
  return builder as never;
}
mock.module("../../db-connection.js", () => ({
  getDb: () => makeFakeDb(),
}));
mock.module("../../v2/now-text.js", () => ({
  loadNowText: async () => "NOW context",
}));
mock.module("../../v2/activation-store.js", () => ({
  hydrate: async () => ({ everInjected: [{ slug: "old/page", turn: 0 }] }),
}));
mock.module("../loop.js", () => ({
  runRetrievalLoop: async (input: RetrievalInput): Promise<RetrievalOutput> => {
    loopCalls.push({ input });
    return loopImpl(input);
  },
}));
mock.module("../../memory-v2-activation-log-store.js", () => ({
  recordMemoryV2ActivationLog: (params: RecordMemoryV2ActivationLogParams) => {
    logCalls.push(params);
  },
}));

const { memoryV3ShadowMiddleware } = await import("../shadow-middleware.js");

// ── Fixtures ─────────────────────────────────────────────────────────────

const trust: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "guardian",
};

function makeCtx(): TurnContext {
  return {
    requestId: "req-shadow-test",
    conversationId: "conv-shadow",
    turnIndex: 3,
    trust,
  };
}

function makeArgs(signal?: AbortSignal): MemoryArgs {
  return {
    conversationId: "conv-shadow",
    trustContext: trust,
    turnIndex: 3,
    signal: signal ?? new AbortController().signal,
  };
}

/** The unchanged downstream (v2/default) result the terminal returns. */
const DOWNSTREAM_RESULT: MemoryResult = {
  pkbContent: "pkb",
  nowContent: "now",
  memoryGraphBlocks: [{ kind: "default.graph" }],
};

/** Flush the detached shadow chain (microtasks + a macrotask hop). */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

beforeEach(() => {
  v3Enabled = false;
  v3Shadow = false;
  v3Present = true;
  loopCalls.length = 0;
  logCalls.length = 0;
  loopImpl = async () => ({
    selectedSlugs: [],
    sourceBySlug: new Map(),
    trace: { passes: [] },
    cost: { ms: 0 },
    failureReason: null,
  });
});

afterEach(() => {
  mock.restore();
});

describe("memory-v3 shadow middleware", () => {
  test("flag off → byte-for-byte pass-through, no v3 call, no log write", async () => {
    v3Enabled = false;
    v3Shadow = false;
    let nextCalls = 0;
    const args = makeArgs();
    const result = await memoryV3ShadowMiddleware(
      args,
      async (a) => {
        nextCalls++;
        // identity is preserved — pass-through hands the same args down.
        expect(a).toBe(args);
        return DOWNSTREAM_RESULT;
      },
      makeCtx(),
    );

    // Returns the exact downstream object reference, unchanged.
    expect(result).toBe(DOWNSTREAM_RESULT);
    expect(nextCalls).toBe(1);

    await flush();
    expect(loopCalls.length).toBe(0);
    expect(logCalls.length).toBe(0);
  });

  test("enabled but shadow off → still a pure pass-through", async () => {
    v3Enabled = true;
    v3Shadow = false;
    const args = makeArgs();
    const result = await memoryV3ShadowMiddleware(
      args,
      async () => DOWNSTREAM_RESULT,
      makeCtx(),
    );
    expect(result).toBe(DOWNSTREAM_RESULT);
    await flush();
    expect(loopCalls.length).toBe(0);
    expect(logCalls.length).toBe(0);
  });

  test("v3 config block absent → pass-through, no throw, no v3 call", async () => {
    // Reproduces the agent-loop test fixtures (and any config built outside the
    // Zod schema) where `memory.v3` is undefined. The gate must not throw.
    v3Present = false;
    const args = makeArgs();
    const result = await memoryV3ShadowMiddleware(
      args,
      async () => DOWNSTREAM_RESULT,
      makeCtx(),
    );
    expect(result).toBe(DOWNSTREAM_RESULT);
    await flush();
    expect(loopCalls.length).toBe(0);
    expect(logCalls.length).toBe(0);
  });

  test("flag on → v3 runs, v3_shadow row logged, downstream result unchanged", async () => {
    v3Enabled = true;
    v3Shadow = true;
    loopImpl = async () => ({
      selectedSlugs: ["topic/a", "topic/b"],
      sourceBySlug: new Map([["topic/a", "dense"]]),
      trace: { passes: [] },
      cost: { ms: 12 },
      failureReason: null,
    });

    const args = makeArgs();
    const result = await memoryV3ShadowMiddleware(
      args,
      async () => DOWNSTREAM_RESULT,
      makeCtx(),
    );

    // The injected result is the v2/default result, NOT v3.
    expect(result).toBe(DOWNSTREAM_RESULT);

    await flush();

    // v3 ran exactly once, with a faithfully-built RetrievalInput.
    expect(loopCalls.length).toBe(1);
    const input = loopCalls[0]!.input;
    expect(input.nowText).toBe("NOW context");
    expect(input.workspaceDir).toBe("/tmp/shadow-test-workspace");
    expect(input.priorEverInjected).toEqual([{ slug: "old/page", turn: 0 }]);
    expect(input.recentTurnPairs.length).toBeGreaterThan(0);
    expect(input.recentTurnPairs.at(-1)?.userMessage).toBe("hello memory");

    // Exactly one v3_shadow row, carrying v3's selection.
    expect(logCalls.length).toBe(1);
    const logged = logCalls[0]!;
    expect(logged.mode).toBe("v3_shadow");
    expect(logged.conversationId).toBe("conv-shadow");
    expect(logged.turn).toBe(3);
    expect(logged.concepts.map((c) => c.slug)).toEqual(["topic/a", "topic/b"]);

    // Per-slug lane provenance is carried from sourceBySlug; a slug absent from
    // the map (topic/b) gets no lane rather than a bogus one.
    const bySlug = new Map(logged.concepts.map((c) => [c.slug, c]));
    expect(bySlug.get("topic/a")?.lane).toBe("dense");
    expect(bySlug.get("topic/b")?.lane).toBeUndefined();
  });

  test("v3 error → logged/swallowed, turn result unaffected, no log row", async () => {
    v3Enabled = true;
    v3Shadow = true;
    loopImpl = async () => {
      throw new Error("v3 boom");
    };

    const args = makeArgs();
    // The middleware must not reject even though the detached shadow throws.
    const result = await memoryV3ShadowMiddleware(
      args,
      async () => DOWNSTREAM_RESULT,
      makeCtx(),
    );
    expect(result).toBe(DOWNSTREAM_RESULT);

    await flush();
    // Loop was attempted; the failure short-circuited before logging.
    expect(loopCalls.length).toBe(1);
    expect(logCalls.length).toBe(0);
  });

  test("aborted signal → shadow does no v3 work", async () => {
    v3Enabled = true;
    v3Shadow = true;
    const controller = new AbortController();
    controller.abort();

    const result = await memoryV3ShadowMiddleware(
      makeArgs(controller.signal),
      async () => DOWNSTREAM_RESULT,
      makeCtx(),
    );
    expect(result).toBe(DOWNSTREAM_RESULT);

    await flush();
    expect(loopCalls.length).toBe(0);
    expect(logCalls.length).toBe(0);
  });
});
