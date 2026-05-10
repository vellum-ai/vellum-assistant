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
  ToolDefinition,
  ToolUseContent,
} from "../../../providers/types.js";

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

mock.module("../../../util/logger.js", () => ({
  getLogger: () => makeRecordingLogger(),
}));

mock.module("../skill-store.js", () => ({
  SKILL_SLUG_PREFIX: "skills/",
  listSkillEntries: () => skillState.entries,
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

mock.module("../../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => providerStub,
  extractToolUse: (response: ProviderResponse) =>
    response.content.find((b): b is ToolUseContent => b.type === "tool_use"),
}));

// IDENTITY.md / users/default.md aren't required for these tests — the
// router falls back to neutral labels when missing, and we don't assert on
// them. No mock needed for `daemon/identity-helpers.js`; it tolerates a
// missing IDENTITY.md by returning null.

const { runRouter } = await import("../router.js");
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
    sendMessage: async (messages, tools, systemPrompt, options) => {
      providerCalls.push({ messages, tools, systemPrompt, options });
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
function makeConfig(overrides?: { maxPageIds?: number }) {
  return {
    memory: {
      v2: {
        enabled: true,
        router: {
          enabled: true,
          max_page_ids: overrides?.maxPageIds ?? 25,
        },
      },
    },
  } as unknown as Parameters<typeof runRouter>[0]["config"];
}

const COMMON_PARAMS = {
  userMessage: "What's on my plate today?",
  assistantMessage: "Let me check your plan.",
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
