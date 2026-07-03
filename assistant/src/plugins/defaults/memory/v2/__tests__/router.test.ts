/**
 * Tests for `assistant/src/memory/v2/router.ts`.
 *
 * Coverage matrix:
 *   - Empty workspace (zero pages, zero skills) → `empty_index` short-circuit.
 *   - No configured provider → `no_provider`.
 *   - Successful tool-use → IDs map to slugs, ordered as the model returned.
 *   - Empty `page_ids` array → success with empty selection (abstention).
 *   - Missing tool_use block → `tool_use_missing`.
 *   - Tool input failing Zod → `schema_mismatch`.
 *   - IDs outside `[1, N]` filtered with warn.
 *   - More than `max_page_ids` returned → truncated with warn.
 *   - Provider throw → `api_error`.
 *   - Abort signal forwarded to the provider call.
 *   - Request shape: system prompt carries page index; user message has the
 *     two text blocks; the NOW block has explicit `cache_control`; tool
 *     choice forces `select_pages_to_inject`.
 *
 * Workspace lives in a `mkdtemp` directory per test; `~/.vellum/` is never
 * touched. The provider is stubbed so no network calls fire.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "@vellumai/plugin-api";

import type { ToolDefinition } from "../../llm-helpers.js";

// ---------------------------------------------------------------------------
// Mocks installed BEFORE the router import so the module observes them at
// load time. The page-index reads concept pages from disk and the skill
// store via `listSkillEntries()` — we mock the skill store here so each
// test starts with a clean (empty by default) skill list and can opt in.
// ---------------------------------------------------------------------------

const skillState: { entries: { id: string; content: string }[] } = {
  entries: [],
};
const warnLogs: Array<{ args: unknown[] }> = [];

// Recursive proxy so `log.<any>()` / `log.child({...}).<any>()` are safe
// no-ops, but `log.warn(...)` records its args for assertion. Mirrors the
// shape of the shared `makeMockLogger` helper so tests in the same run
// can't observe a foreign mock from a sibling file.
function makeRecordingLogger(): unknown {
  return new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) => {
      if (prop === "child") return makeRecordingLogger;
      if (prop === "warn") {
        return (...args: unknown[]) => {
          warnLogs.push({ args });
        };
      }
      return () => {};
    },
  });
}

mock.module("../../../../../util/logger.js", () => ({
  getLogger: () => makeRecordingLogger(),
}));

mock.module("../skill-store.js", () => ({
  SKILL_SLUG_PREFIX: "skills/",
  listSkillEntries: () => skillState.entries,
}));

// Stub `computeInjectionScores` so tier-2 tests can dictate scores
// without spinning up a real bun:sqlite db. Real production wiring is
// covered by the splitTier2 unit tests in page-index.test.ts and the
// score-formula tests in injection-events.test.ts.
const scoresStub = new Map<string, number>();
mock.module("../injection-events.js", () => ({
  computeInjectionScores: (
    _db: unknown,
    slugs: readonly string[],
    _now: number,
  ): Map<string, number> => {
    const out = new Map<string, number>();
    for (const slug of slugs) {
      const score = scoresStub.get(slug);
      if (score !== undefined && score > 0) out.set(slug, score);
    }
    return out;
  },
}));

// Provider stub. Each test sets `providerStub` to control the response;
// `null` simulates "no configured provider available".
let providerStub: Provider | null = null;

interface ProviderCall {
  messages: Message[];
  tools: ToolDefinition[] | undefined;
  systemPrompt: string | undefined;
  options: SendMessageOptions | undefined;
}
const providerCalls: ProviderCall[] = [];

// The router imports `getConfiguredProvider` from `@vellumai/plugin-api`; the
// pure `extractToolUse` helper runs for real from the plugin's `llm-helpers`.
mock.module("@vellumai/plugin-api", () => ({
  getConfiguredProvider: async () => providerStub,
}));

// IDENTITY.md / users/default.md aren't required for these tests — the
// router falls back to neutral labels when missing, and we don't assert on
// them. No mock needed for `daemon/identity-helpers.js`; it tolerates a
// missing IDENTITY.md by returning null.

const { runRouter, applyHistoricalCharBudget } = await import("../router.js");
const { getPageIndex, invalidatePageIndex } = await import("../page-index.js");
const { writePage } = await import("../page-store.js");

// ---------------------------------------------------------------------------
// Per-test workspace + reset hooks.
// ---------------------------------------------------------------------------

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "memory-v2-router-test-"));
  skillState.entries = [];
  providerStub = null;
  providerCalls.length = 0;
  warnLogs.length = 0;
  scoresStub.clear();
  invalidatePageIndex();
});

afterEach(() => {
  invalidatePageIndex();
  rmSync(workspaceDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function makeProvider(response: ProviderResponse): Provider {
  return {
    name: "stub",
    sendMessage: async (messages, options) => {
      providerCalls.push({
        messages,
        tools: options?.tools,
        systemPrompt: options?.systemPrompt,
        options,
      });
      // Honor abort like a real provider would — if the signal already
      // aborted, throw the canonical AbortError so callers can assert that
      // signal forwarding actually has teeth.
      if (options?.signal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      return response;
    },
  };
}

function toolUseResponse(pageIds: number[]): ProviderResponse {
  return {
    model: "stub-model",
    stopReason: "tool_use",
    usage: { inputTokens: 0, outputTokens: 0 },
    content: [
      {
        type: "tool_use",
        id: "tu-1",
        name: "select_pages_to_inject",
        input: { page_ids: pageIds },
      },
    ],
  };
}

function badShapeResponse(input: Record<string, unknown>): ProviderResponse {
  return {
    model: "stub-model",
    stopReason: "tool_use",
    usage: { inputTokens: 0, outputTokens: 0 },
    content: [
      {
        type: "tool_use",
        id: "tu-1",
        name: "select_pages_to_inject",
        input,
      },
    ],
  };
}

function makePage(
  slug: string,
  opts: { summary?: string; edges?: string[] } = {},
) {
  return {
    slug,
    frontmatter: {
      edges: opts.edges ?? [],
      ref_files: [],
      ref_urls: [],
      ...(opts.summary !== undefined ? { summary: opts.summary } : {}),
    },
    body: "",
  };
}

// Default config object — mirrors the schema defaults but trimmed to the
// fields the router actually reads. Cast through `as unknown` because the
// production type is a heavy nested schema; we only exercise the v2.router
// branch in this test file.
function makeConfig(overrides?: {
  maxPageIds?: number;
  batchSize?: number | null;
  tier1Size?: number | null;
  tier2Size?: number | null;
  historicalPairsMaxChars?: number | null;
}) {
  return {
    memory: {
      v2: {
        enabled: true,
        router: {
          enabled: true,
          max_page_ids: overrides?.maxPageIds ?? 25,
          batch_size: overrides?.batchSize ?? null,
          tier1_size: overrides?.tier1Size ?? null,
          tier2_size: overrides?.tier2Size ?? null,
          historical_pairs_max_chars:
            overrides?.historicalPairsMaxChars ?? null,
        },
      },
    },
  } as unknown as Parameters<typeof runRouter>[0]["config"];
}

const COMMON_PARAMS = {
  recentTurnPairs: [
    {
      assistantMessage: "Let me check your plan.",
      userMessage: "What's on my plate today?",
    },
  ],
  nowText: "2026-05-10 14:00 PT",
  priorEverInjected: [] as { slug: string; turn: number }[],
};

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("runRouter — early bails", () => {
  test("returns empty_index when the workspace has no pages and no skills", async () => {
    providerStub = makeProvider(toolUseResponse([1]));

    const result = await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig(),
    });

    expect(result).toEqual({
      selectedSlugs: [],
      sourceBySlug: new Map(),
      failureReason: "empty_index",
    });
    // Provider must NOT be invoked when there is nothing to route.
    expect(providerCalls).toHaveLength(0);
  });

  test("returns no_provider when getConfiguredProvider yields null", async () => {
    await writePage(workspaceDir, makePage("alice", { summary: "Alice" }));
    providerStub = null;

    const result = await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig(),
    });

    expect(result.failureReason).toBe("no_provider");
    expect(result.selectedSlugs).toEqual([]);
    expect(providerCalls).toHaveLength(0);
  });
});

describe("runRouter — successful tool_use", () => {
  beforeEach(async () => {
    // Build a 3-page workspace. Sorted by slug → [alpha, bravo, charlie] →
    // IDs [1, 2, 3].
    await writePage(workspaceDir, makePage("alpha", { summary: "A" }));
    await writePage(workspaceDir, makePage("bravo", { summary: "B" }));
    await writePage(workspaceDir, makePage("charlie", { summary: "C" }));
  });

  test("maps returned IDs to slugs in model-returned order", async () => {
    providerStub = makeProvider(toolUseResponse([3, 1]));

    const result = await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig(),
    });

    expect(result.failureReason).toBeNull();
    expect(result.selectedSlugs).toEqual(["charlie", "alpha"]);
  });

  test("empty page_ids is the abstention path — success with empty selection", async () => {
    providerStub = makeProvider(toolUseResponse([]));

    const result = await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig(),
    });

    expect(result).toEqual({
      selectedSlugs: [],
      sourceBySlug: new Map(),
      failureReason: null,
    });
  });

  test("forces tool_choice to select_pages_to_inject", async () => {
    providerStub = makeProvider(toolUseResponse([1]));

    await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig(),
    });

    expect(providerCalls).toHaveLength(1);
    const [call] = providerCalls;
    const callConfig = call.options?.config as Record<string, unknown>;
    expect(callConfig?.callSite).toBe("memoryRouter");
    expect(callConfig?.tool_choice).toEqual({
      type: "tool",
      name: "select_pages_to_inject",
    });
    expect(call.tools).toHaveLength(1);
    expect(call.tools?.[0].name).toBe("select_pages_to_inject");
  });

  test("tool maxItems reflects configured max_page_ids", async () => {
    providerStub = makeProvider(toolUseResponse([1]));

    await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig({ maxPageIds: 50 }),
    });

    const [call] = providerCalls;
    const schema = call.tools?.[0].input_schema as {
      properties: { page_ids: { maxItems: number } };
    };
    expect(schema.properties.page_ids.maxItems).toBe(50);
    expect(call.tools?.[0].description).toContain("up to 50");
  });

  test("system prompt carries the rendered page index", async () => {
    providerStub = makeProvider(toolUseResponse([1]));

    await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig(),
    });

    const idx = await getPageIndex(workspaceDir);
    const sys = providerCalls[0].systemPrompt;
    expect(sys).toBeTruthy();
    // Each entry's rendered line should appear verbatim.
    for (const entry of idx.entries) {
      expect(sys).toContain(`[${entry.id}] ${entry.slug}`);
    }
  });

  test("user message has two text blocks: <now> and <last_turn>+already_injected", async () => {
    providerStub = makeProvider(toolUseResponse([1]));

    await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      priorEverInjected: [{ slug: "alpha", turn: 1 }],
      config: makeConfig(),
    });

    const [call] = providerCalls;
    expect(call.messages).toHaveLength(1);
    const userMsg = call.messages[0];
    expect(userMsg.role).toBe("user");
    expect(userMsg.content).toHaveLength(2);

    const [blockA, blockB] = userMsg.content as Array<{
      type: string;
      text: string;
      cache_control?: { type: string; ttl?: string };
    }>;

    // Block A — NOW with explicit ephemeral cache breakpoint at 1h TTL
    // (matches the provider's auto-applied breakpoints; the default 5m
    // would force re-creation across most turns since `<now>` is stable).
    expect(blockA.type).toBe("text");
    expect(blockA.text).toContain("<now>");
    expect(blockA.text).toContain("2026-05-10 14:00 PT");
    expect(blockA.text).toContain("</now>");
    expect(blockA.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

    // Block B — already-injected IDs + last turn, NO cache_control.
    expect(blockB.type).toBe("text");
    expect(blockB.text).toContain("<already_injected_ids>");
    expect(blockB.text).toContain("1"); // alpha → id 1
    expect(blockB.text).toContain("<last_turn>");
    expect(blockB.text).toContain("[user]: What's on my plate today?");
    expect(blockB.text).toContain("[assistant]: Let me check your plan.");
    expect(blockB.cache_control).toBeUndefined();
  });

  test("runRouterBatch front-truncates the oldest <last_turn> message when the char budget is exceeded", async () => {
    await writePage(workspaceDir, makePage("alpha", { summary: "A" }));
    providerStub = makeProvider(toolUseResponse([1]));

    const longAssistant = "A".repeat(2_000);
    const longUser = "B".repeat(2_000);
    const recentAssistant = "Short prior.";
    const justArrived = "What's relevant?";

    await runRouter({
      workspaceDir,
      recentTurnPairs: [
        { assistantMessage: longAssistant, userMessage: longUser },
        { assistantMessage: recentAssistant, userMessage: justArrived },
      ],
      nowText: "now",
      priorEverInjected: [],
      // Budget: just enough room for the most-recent pair plus the old user
      // line in full, leaving a small slice for the very oldest assistant
      // (which should be front-truncated with the `…` marker).
      config: makeConfig({
        historicalPairsMaxChars:
          recentAssistant.length + justArrived.length + longUser.length + 50,
      }),
    });

    const [call] = providerCalls;
    const userMsg = call.messages[0];
    const blockB = userMsg.content[1] as { text: string };

    // The just-arrived user message and the prior assistant reply survive
    // verbatim because they're newest in the walk.
    expect(blockB.text).toContain(`[user]: ${justArrived}`);
    expect(blockB.text).toContain(`[assistant]: ${recentAssistant}`);

    // The older user message survives verbatim (next newest after the
    // most-recent pair).
    expect(blockB.text).toContain(`[user]: ${longUser}`);

    // The oldest message in the walk (the older assistant) is
    // front-truncated, so its rendered line starts with the `…` marker
    // and ends with the suffix of the original text.
    expect(blockB.text).toContain("[assistant]: …");
    expect(blockB.text.endsWith(`A\n</last_turn>`)).toBe(false); // sanity
    // The full untruncated long-assistant string must NOT appear.
    expect(blockB.text.includes(longAssistant)).toBe(false);
    // The TAIL of the long-assistant string SHOULD appear (kept from front-truncation).
    expect(blockB.text).toContain(longAssistant.slice(-10));
  });

  test("null historical_pairs_max_chars renders pairs verbatim regardless of size", async () => {
    await writePage(workspaceDir, makePage("alpha", { summary: "A" }));
    providerStub = makeProvider(toolUseResponse([1]));

    const huge = "X".repeat(5_000);
    await runRouter({
      workspaceDir,
      recentTurnPairs: [
        { assistantMessage: huge, userMessage: "just arrived" },
      ],
      nowText: "now",
      priorEverInjected: [],
      config: makeConfig(), // historical_pairs_max_chars: null
    });

    const [call] = providerCalls;
    const blockB = call.messages[0].content[1] as { text: string };
    expect(blockB.text).toContain(`[assistant]: ${huge}`);
    expect(blockB.text).toContain("[user]: just arrived");
    expect(blockB.text).not.toContain("…");
  });

  test("de-duplicates repeated IDs from the model while preserving order", async () => {
    providerStub = makeProvider(toolUseResponse([2, 1, 2]));

    const result = await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig(),
    });

    expect(result.selectedSlugs).toEqual(["bravo", "alpha"]);
  });
});

describe("runRouter — failure modes", () => {
  beforeEach(async () => {
    await writePage(workspaceDir, makePage("alpha", { summary: "A" }));
    await writePage(workspaceDir, makePage("bravo", { summary: "B" }));
    await writePage(workspaceDir, makePage("charlie", { summary: "C" }));
  });

  test("missing tool_use block → tool_use_missing", async () => {
    providerStub = makeProvider({
      model: "stub-model",
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
      content: [{ type: "text", text: "I have nothing to add." }],
    });

    const result = await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig(),
    });

    expect(result.failureReason).toBe("tool_use_missing");
    expect(result.selectedSlugs).toEqual([]);
  });

  test("tool input failing Zod → schema_mismatch with warn log", async () => {
    providerStub = makeProvider(badShapeResponse({ wrong_key: [1, 2] }));

    const result = await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig(),
    });

    expect(result.failureReason).toBe("schema_mismatch");
    // At least one warn log was emitted with a Zod-shaped error.
    const warnSeen = warnLogs.some((l) =>
      JSON.stringify(l.args).includes("schema"),
    );
    expect(warnSeen).toBe(true);
  });

  test("IDs outside [1, N] are filtered with warn", async () => {
    // N = 3. Returning [2, 99, 0, -1] should keep only [2].
    providerStub = makeProvider(toolUseResponse([2, 99, 0, -1]));

    const result = await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig(),
    });

    expect(result.failureReason).toBeNull();
    expect(result.selectedSlugs).toEqual(["bravo"]);
    const warnSeen = warnLogs.some((l) =>
      JSON.stringify(l.args).includes("outside the valid range"),
    );
    expect(warnSeen).toBe(true);
  });

  test("duplicate-heavy IDs are deduped before the cap is applied", async () => {
    // [1, 1, 2] with max=2 must yield two distinct slugs, not collapse to one
    // after a pre-dedupe slice trims away the only other unique ID.
    providerStub = makeProvider(toolUseResponse([1, 1, 2]));

    const result = await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig({ maxPageIds: 2 }),
    });

    expect(result.failureReason).toBeNull();
    expect(result.selectedSlugs).toEqual(["alpha", "bravo"]);
  });

  test("more than max_page_ids → truncated with warn", async () => {
    providerStub = makeProvider(toolUseResponse([1, 2, 3]));

    const result = await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig({ maxPageIds: 2 }),
    });

    expect(result.failureReason).toBeNull();
    expect(result.selectedSlugs).toEqual(["alpha", "bravo"]);
    const warnSeen = warnLogs.some((l) =>
      JSON.stringify(l.args).includes("more page IDs than max_page_ids"),
    );
    expect(warnSeen).toBe(true);
  });

  test("provider throw → api_error", async () => {
    providerStub = {
      name: "throwing",
      sendMessage: async () => {
        throw new Error("boom");
      },
    };

    const result = await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig(),
    });

    expect(result.failureReason).toBe("api_error");
    expect(result.selectedSlugs).toEqual([]);
  });

  test("aborted signal propagates as api_error (provider throw caught)", async () => {
    providerStub = makeProvider(toolUseResponse([1]));

    const controller = new AbortController();
    controller.abort();

    const result = await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig(),
      signal: controller.signal,
    });

    expect(result.failureReason).toBe("api_error");
    expect(providerCalls).toHaveLength(1);
    // Signal must be forwarded — otherwise the stub's aborted-check wouldn't fire.
    expect(providerCalls[0].options?.signal).toBe(controller.signal);
  });
});

// ---------------------------------------------------------------------------
// Batched routing (config.memory.v2.router.batch_size).
// ---------------------------------------------------------------------------

describe("runRouter — batched (batch_size set)", () => {
  beforeEach(async () => {
    // 5 pages → at batch_size=2 we get ceil(5/2)=3 batches.
    await writePage(workspaceDir, makePage("alpha", { summary: "A" }));
    await writePage(workspaceDir, makePage("bravo", { summary: "B" }));
    await writePage(workspaceDir, makePage("charlie", { summary: "C" }));
    await writePage(workspaceDir, makePage("delta", { summary: "D" }));
    await writePage(workspaceDir, makePage("echo", { summary: "E" }));
  });

  test("fires one provider call per batch in parallel", async () => {
    // Every batch returns its local id 1 → at most 3 distinct slugs in the
    // union (one per batch), but we don't assert WHICH slugs the FNV
    // bucketing picks; just that the provider was called once per batch.
    providerStub = makeProvider(toolUseResponse([1]));

    const result = await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig({ batchSize: 2 }),
    });

    expect(result.failureReason).toBeNull();
    expect(providerCalls.length).toBeGreaterThan(1);
    expect(providerCalls.length).toBeLessThanOrEqual(3);
    // Every batch picked its own local id 1 → distinct slugs in union.
    expect(result.selectedSlugs.length).toBe(providerCalls.length);
    expect(new Set(result.selectedSlugs).size).toBe(
      result.selectedSlugs.length,
    );
  });

  test("each batch's system prompt contains only its own subset of slugs", async () => {
    providerStub = makeProvider(toolUseResponse([1]));
    await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig({ batchSize: 2 }),
    });

    // Across all batch calls, every slug appears in exactly one prompt.
    const allSlugs = ["alpha", "bravo", "charlie", "delta", "echo"];
    const appearances = new Map<string, number>(allSlugs.map((s) => [s, 0]));
    for (const call of providerCalls) {
      for (const slug of allSlugs) {
        if (call.systemPrompt?.includes(slug)) {
          appearances.set(slug, (appearances.get(slug) ?? 0) + 1);
        }
      }
    }
    for (const slug of allSlugs) {
      expect(appearances.get(slug)).toBe(1);
    }
  });

  test("union of selected slugs is deduplicated across batches", async () => {
    // Every batch returns its local id 1. Same slug could appear in only
    // one batch (since each slug lives in exactly one batch), so the union
    // is naturally unique. Sanity-check the dedup path with a 2-call response.
    providerStub = makeProvider(toolUseResponse([1, 1]));
    const result = await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig({ batchSize: 2 }),
    });
    expect(result.failureReason).toBeNull();
    expect(new Set(result.selectedSlugs).size).toBe(
      result.selectedSlugs.length,
    );
  });

  test("priorEverInjected is filtered to the batch's own slugs as local IDs", async () => {
    providerStub = makeProvider(toolUseResponse([1]));
    await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      priorEverInjected: [
        { slug: "alpha", turn: 1 },
        { slug: "echo", turn: 1 },
      ],
      config: makeConfig({ batchSize: 2 }),
    });

    // Exactly the batches containing alpha or echo should mention any
    // already_injected_id; other batches should have an empty list.
    for (const call of providerCalls) {
      const text =
        (call.messages[0].content as Array<{ text?: string }>)[1]?.text ?? "";
      const hasAlpha = call.systemPrompt?.includes("alpha");
      const hasEcho = call.systemPrompt?.includes("echo");
      const expectsId = hasAlpha || hasEcho;
      // Block contents: "<already_injected_ids>\n{ids}\n</already_injected_ids>"
      const match = text.match(
        /<already_injected_ids>\n([^\n]*)\n<\/already_injected_ids>/,
      );
      const idsStr = match?.[1] ?? "";
      if (expectsId) {
        expect(idsStr.trim().length).toBeGreaterThan(0);
      } else {
        expect(idsStr.trim()).toBe("");
      }
    }
  });

  test("partial failure: one batch fails, others succeed → union returned with success", async () => {
    let callCount = 0;
    providerStub = {
      name: "partial-failure",
      sendMessage: async (messages, options) => {
        callCount += 1;
        providerCalls.push({
          messages,
          tools: options?.tools,
          systemPrompt: options?.systemPrompt,
          options,
        });
        if (callCount === 1) throw new Error("batch 1 boom");
        return toolUseResponse([1]);
      },
    };

    const result = await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig({ batchSize: 2 }),
    });

    expect(result.failureReason).toBeNull();
    expect(result.selectedSlugs.length).toBeGreaterThan(0);
    expect(providerCalls.length).toBeGreaterThan(1);
  });

  test("all batches fail → unified failure with first batch's reason", async () => {
    providerStub = {
      name: "all-fail",
      sendMessage: async () => {
        throw new Error("all batches boom");
      },
    };

    const result = await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig({ batchSize: 2 }),
    });

    expect(result.failureReason).toBe("api_error");
    expect(result.selectedSlugs).toEqual([]);
  });

  test("union across batches is truncated to global max_page_ids", async () => {
    // 5 pages, batch_size=1 → 5 batches, each picks its own local id 1.
    // Without a global cap the union would be 5; max_page_ids=2 forces
    // truncation back to 2.
    providerStub = makeProvider(toolUseResponse([1]));

    const result = await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig({ batchSize: 1, maxPageIds: 2 }),
    });

    expect(result.failureReason).toBeNull();
    expect(result.selectedSlugs).toHaveLength(2);
    // sourceBySlug must stay aligned with the truncated selection.
    expect(result.sourceBySlug.size).toBe(2);
    for (const slug of result.selectedSlugs) {
      expect(result.sourceBySlug.get(slug)).toBeDefined();
    }
    const warned = warnLogs.some((l) =>
      JSON.stringify(l.args).includes("union across batches exceeded"),
    );
    expect(warned).toBe(true);
  });

  test("batch_size larger than index size is single batch (same as v3)", async () => {
    providerStub = makeProvider(toolUseResponse([1]));
    const result = await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig({ batchSize: 1000 }),
    });
    expect(result.failureReason).toBeNull();
    expect(providerCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tier 1 (recently modified) splitting.
// ---------------------------------------------------------------------------

const { utimes } = await import("node:fs/promises");

describe("runRouter — tier 1 (recently modified)", () => {
  async function setMtime(slug: string, epochMs: number): Promise<void> {
    const seconds = epochMs / 1000;
    await utimes(
      join(workspaceDir, "memory", "concepts", `${slug}.md`),
      seconds,
      seconds,
    );
  }

  beforeEach(async () => {
    await writePage(workspaceDir, makePage("alpha", { summary: "A" }));
    await writePage(workspaceDir, makePage("bravo", { summary: "B" }));
    await writePage(workspaceDir, makePage("charlie", { summary: "C" }));
    await writePage(workspaceDir, makePage("delta", { summary: "D" }));
    await writePage(workspaceDir, makePage("echo", { summary: "E" }));
  });

  test("tier1_size + batch_size both null is the v3 single-batch path", async () => {
    providerStub = makeProvider(toolUseResponse([1]));
    const result = await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig(),
    });
    expect(result.failureReason).toBeNull();
    expect(providerCalls).toHaveLength(1);
  });

  test("tier1_size=2 + batch_size=null produces 2 batches (tier1 + rest)", async () => {
    providerStub = makeProvider(toolUseResponse([1]));
    const result = await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig({ tier1Size: 2 }),
    });
    expect(result.failureReason).toBeNull();
    expect(providerCalls).toHaveLength(2);
  });

  test("tier 1 contains the most recently modified pages", async () => {
    // Stamp distinct mtimes so the ordering is unambiguous.
    await setMtime("alpha", 1_000_000);
    await setMtime("bravo", 5_000_000); // most recent
    await setMtime("charlie", 2_000_000);
    await setMtime("delta", 4_000_000); // 2nd most recent
    await setMtime("echo", 3_000_000);

    providerStub = makeProvider(toolUseResponse([1]));
    await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig({ tier1Size: 2 }),
    });

    // Tier 1 is the first provider call. Match `[N] slug` lines specifically
    // — string-search on slug name alone would false-positive on prompt
    // template text that may mention the same words.
    const tier1Prompt = providerCalls[0].systemPrompt ?? "";
    const indexedSlugs = new Set(
      [...tier1Prompt.matchAll(/^\[\d+\] (\S+)/gm)].map((m) => m[1]),
    );
    expect(indexedSlugs).toEqual(new Set(["bravo", "delta"]));
  });

  test("tier1_size=2 + batch_size=2 puts every slug in exactly one batch", async () => {
    providerStub = makeProvider(toolUseResponse([1]));
    await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig({ tier1Size: 2, batchSize: 2 }),
    });
    // 5 pages, tier1=2, rest=3 → 1 tier1 batch + 1-or-2 tier3 batches
    // depending on whether FNV hash distributes the 3 rest slugs into both
    // buckets. The empty-batch filter drops a bucket that lands empty, so
    // the strong invariant is "every slug appears in exactly one batch."
    expect(providerCalls.length).toBeGreaterThanOrEqual(2);
    expect(providerCalls.length).toBeLessThanOrEqual(3);

    const allSlugs = ["alpha", "bravo", "charlie", "delta", "echo"];
    const appearances = new Map<string, number>(
      allSlugs.map((s) => [s, 0] as [string, number]),
    );
    for (const call of providerCalls) {
      for (const slug of allSlugs) {
        if (call.systemPrompt?.includes(slug)) {
          appearances.set(slug, (appearances.get(slug) ?? 0) + 1);
        }
      }
    }
    for (const slug of allSlugs) {
      expect(appearances.get(slug)).toBe(1);
    }
  });

  test("tier1_size >= total pages → single tier 1 batch, no rest", async () => {
    providerStub = makeProvider(toolUseResponse([1]));
    await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig({ tier1Size: 100 }),
    });
    // 5 pages, tier1_size=100 → only tier 1 fires; the empty rest is dropped.
    expect(providerCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tier 2 (highest-EMA) splitting.
// ---------------------------------------------------------------------------

describe("runRouter — tier 2 (highest EMA)", () => {
  // Any non-null value passes the `params.database` check in the orchestrator;
  // the real db is never touched because computeInjectionScores is mocked.
  const stubDb = {} as Parameters<typeof runRouter>[0]["database"];

  beforeEach(async () => {
    await writePage(workspaceDir, makePage("alpha", { summary: "A" }));
    await writePage(workspaceDir, makePage("bravo", { summary: "B" }));
    await writePage(workspaceDir, makePage("charlie", { summary: "C" }));
    await writePage(workspaceDir, makePage("delta", { summary: "D" }));
    await writePage(workspaceDir, makePage("echo", { summary: "E" }));
  });

  test("tier2_size + tier1_size both null is the v3 single-batch path", async () => {
    providerStub = makeProvider(toolUseResponse([1]));
    await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig(),
      database: stubDb,
    });
    expect(providerCalls).toHaveLength(1);
  });

  test("tier2_size=2 produces 2 batches (tier 2 + rest)", async () => {
    scoresStub.set("alpha", 1.0);
    scoresStub.set("bravo", 5.0);
    scoresStub.set("delta", 4.0);

    providerStub = makeProvider(toolUseResponse([1]));
    await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig({ tier2Size: 2 }),
      database: stubDb,
    });
    expect(providerCalls.length).toBe(2);

    // Tier 2 is the first batch (no tier 1 in this test). Its prompt should
    // contain exactly the top-2 by score: bravo (5) and delta (4).
    const tier2Prompt = providerCalls[0].systemPrompt ?? "";
    const indexedSlugs = new Set(
      [...tier2Prompt.matchAll(/^\[\d+\] (\S+)/gm)].map((m) => m[1]),
    );
    expect(indexedSlugs).toEqual(new Set(["bravo", "delta"]));
  });

  test("tier 1 then tier 2 then rest — three batches in that order", async () => {
    // Pin mtimes so tier 1 is deterministic: alpha + bravo are the two
    // most recent (highest mtime values). Tier 2 runs on the rest
    // (charlie, delta, echo) using scores we control.
    const { utimes } = await import("node:fs/promises");
    const stamp = async (slug: string, s: number) =>
      utimes(join(workspaceDir, "memory", "concepts", `${slug}.md`), s, s);
    await stamp("alpha", 9000);
    await stamp("bravo", 8000);
    await stamp("charlie", 3000);
    await stamp("delta", 2000);
    await stamp("echo", 1000);
    invalidatePageIndex();

    scoresStub.set("charlie", 2.0);
    scoresStub.set("delta", 3.0);
    // echo has no score → ineligible for tier 2.

    providerStub = makeProvider(toolUseResponse([1]));
    await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig({ tier1Size: 2, tier2Size: 2 }),
      database: stubDb,
    });
    expect(providerCalls.length).toBe(3);

    // Tier 2 batch (index 1) contains charlie + delta. Echo went to rest.
    const tier2Prompt = providerCalls[1].systemPrompt ?? "";
    const tier2Slugs = new Set(
      [...tier2Prompt.matchAll(/^\[\d+\] (\S+)/gm)].map((m) => m[1]),
    );
    expect(tier2Slugs).toEqual(new Set(["charlie", "delta"]));

    // Echo (no score) must land in the rest batch, not tier 2.
    const restPrompt = providerCalls[2].systemPrompt ?? "";
    const restSlugs = new Set(
      [...restPrompt.matchAll(/^\[\d+\] (\S+)/gm)].map((m) => m[1]),
    );
    expect(restSlugs).toEqual(new Set(["echo"]));
  });

  test("score=0 pages stay in rest even when tier2_size is large", async () => {
    // Only one page has a positive score; tier2_size=100 should NOT pull in
    // zero-score pages.
    scoresStub.set("bravo", 5.0);

    providerStub = makeProvider(toolUseResponse([1]));
    await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig({ tier2Size: 100 }),
      database: stubDb,
    });
    expect(providerCalls.length).toBe(2);
    const tier2Prompt = providerCalls[0].systemPrompt ?? "";
    expect(tier2Prompt).toContain("[1] bravo");
    expect(tier2Prompt).not.toMatch(/^\[\d+\] alpha/m);
  });

  test("sourceBySlug tags each selection with its batch tier", async () => {
    scoresStub.set("bravo", 5.0);
    scoresStub.set("delta", 3.0);

    providerStub = makeProvider(toolUseResponse([1]));
    const result = await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig({ tier1Size: 1, tier2Size: 1 }),
      database: stubDb,
    });

    // Every selected slug should have a tier tag — exactly one of:
    // "tier1", "tier2", or "tier3:N" (N starts at 0).
    for (const slug of result.selectedSlugs) {
      const source = result.sourceBySlug.get(slug);
      expect(source).toBeDefined();
      expect(
        source === "tier1" ||
          source === "tier2" ||
          source!.startsWith("tier3:"),
      ).toBe(true);
    }
    // Tier 1 + tier 2 + (some tier 3 batches) ≥ 3 batches → at least one
    // slug per tier should be present in the source map across the union.
    const tags = new Set(result.sourceBySlug.values());
    expect(tags.has("tier1")).toBe(true);
    expect(tags.has("tier2")).toBe(true);
  });

  test("tier2_size set without database logs a warn and skips tier 2", async () => {
    scoresStub.set("bravo", 5.0);
    providerStub = makeProvider(toolUseResponse([1]));
    await runRouter({
      workspaceDir,
      ...COMMON_PARAMS,
      config: makeConfig({ tier2Size: 2 }),
      // No database → tier 2 silently skipped.
    });
    expect(providerCalls).toHaveLength(1);
    const warned = warnLogs.some((l) =>
      JSON.stringify(l.args).includes("tier2_size set but no database"),
    );
    expect(warned).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyHistoricalCharBudget — pure helper covering the cap semantics.
// ---------------------------------------------------------------------------

describe("applyHistoricalCharBudget", () => {
  test("null budget is a no-op (returns a shallow copy)", () => {
    const pairs = [
      { assistantMessage: "older asst", userMessage: "older user" },
      { assistantMessage: "newer asst", userMessage: "newer user" },
    ];
    const out = applyHistoricalCharBudget(pairs, null);
    expect(out).toEqual(pairs);
    // shallow copy — not the same array reference, so callers can mutate freely
    expect(out).not.toBe(pairs);
  });

  test("budget that fits every message returns content unchanged", () => {
    const pairs = [
      { assistantMessage: "AA", userMessage: "UU" },
      { assistantMessage: "BB", userMessage: "VV" },
    ];
    const total = "AA".length + "UU".length + "BB".length + "VV".length; // 8
    const out = applyHistoricalCharBudget(pairs, total);
    expect(out).toEqual(pairs);
  });

  test("front-truncates the oldest still-includable message when the cap is exceeded", () => {
    // Newest user is 10 chars, newest assistant is 10, older user is 10,
    // older assistant is 20. Budget 35 leaves remaining = 35 - 10 - 10 - 10 = 5
    // for the older assistant; 5 - 1 marker char = 4 kept chars from the END.
    const pairs = [
      { assistantMessage: "ABCDEFGHIJKLMNOPQRST", userMessage: "old-user--" },
      { assistantMessage: "abcdefghij", userMessage: "uvwxyzUVWX" },
    ];
    const out = applyHistoricalCharBudget(pairs, 35);
    expect(out).toEqual([
      { assistantMessage: "…QRST", userMessage: "old-user--" },
      { assistantMessage: "abcdefghij", userMessage: "uvwxyzUVWX" },
    ]);
    // Sanity: total content chars equals the budget.
    const totalChars = out.reduce(
      (acc, p) => acc + p.assistantMessage.length + p.userMessage.length,
      0,
    );
    expect(totalChars).toBe(35);
  });

  test("drops older pairs entirely when even their first message has no room", () => {
    // Budget 20 fits the most-recent pair exactly (10 + 10 = 20) and leaves
    // zero room for the older pair, which is dropped entirely.
    const pairs = [
      { assistantMessage: "OLD-ASST00", userMessage: "OLD-USER00" },
      { assistantMessage: "NEW-ASST00", userMessage: "NEW-USER00" },
    ];
    const out = applyHistoricalCharBudget(pairs, 20);
    expect(out).toEqual([
      { assistantMessage: "NEW-ASST00", userMessage: "NEW-USER00" },
    ]);
  });

  test("drops the older message of the current pair when the user line consumes the whole budget", () => {
    // Budget 10 just barely covers the newest user (10 chars). The pair's
    // own assistant message has no room and is dropped (left empty).
    const pairs = [
      { assistantMessage: "ASSISTANTX", userMessage: "USER-NEW10" },
    ];
    const out = applyHistoricalCharBudget(pairs, 10);
    expect(out).toEqual([{ assistantMessage: "", userMessage: "USER-NEW10" }]);
  });

  test("non-positive budgets return an empty array (no message survives)", () => {
    const pairs = [{ assistantMessage: "x", userMessage: "y" }];
    expect(applyHistoricalCharBudget(pairs, 0)).toEqual(pairs);
    // Negative budgets are degenerate but should not throw.
    expect(applyHistoricalCharBudget(pairs, -5)).toEqual(pairs);
  });

  test("budget smaller than the truncation marker drops the would-truncate message", () => {
    // Budget 11: covers full newest user (10 chars). Remaining 1 char is not
    // enough room for the marker, so the next message (newest assistant)
    // is dropped entirely rather than emitting a marker-only message.
    const pairs = [
      { assistantMessage: "ASSISTANTX", userMessage: "USER-NEW10" },
    ];
    const out = applyHistoricalCharBudget(pairs, 11);
    expect(out).toEqual([{ assistantMessage: "", userMessage: "USER-NEW10" }]);
  });
});
