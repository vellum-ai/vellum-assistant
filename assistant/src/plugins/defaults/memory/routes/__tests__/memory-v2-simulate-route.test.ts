/**
 * Tests for the `memory_v2_simulate_router` route handler.
 *
 * The route is a read-only playground for previewing router config knob
 * changes (`tier1_size`, `tier2_size`, `batch_size`) against the live page
 * index. Tests assert:
 *   1. The handler returns selected slugs with `sourceBySlug` populated.
 *   2. Overrides are reflected in the response's `effectiveConfig`.
 *   3. The handler never calls `recordInjectionEvents` — the simulate path
 *      must not touch the EMA event log.
 *
 * Workspace lives in a `mkdtemp` directory per test; `~/.vellum/` is never
 * touched. The provider and DB are stubbed so no network or SQLite I/O
 * fires.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  Message,
  Provider,
  SendMessageOptions,
} from "@vellumai/plugin-api";

import type { ToolDefinition } from "../../llm-helpers.js";

// ---------------------------------------------------------------------------
// Mocks (installed before the route module is imported)
// ---------------------------------------------------------------------------

// Skill store: empty by default so the page index only contains test pages.
mock.module("../../v2/skill-store.js", () => ({
  SKILL_SLUG_PREFIX: "skills/",
  listSkillEntries: () => [],
  seedV2SkillEntries: async () => undefined,
}));

// NOW.md loader: return a fixed string. The route reads NOW from the
// workspace at call time; stubbing keeps the test independent of disk state.
mock.module("../../v2/now-text.js", () => ({
  loadNowText: async () => "2026-05-22 14:00 PT",
}));

// Injection-events module. `recordInjectionEvents` must never be called by
// the simulate path — record any call so the assertion catches a regression.
// `computeInjectionScores` is called twice per simulate (once inside runRouter
// for tier 2, once in the handler for the response payload); always returns
// zero scores since the test workspace has no event history.
const recordCalls: Array<{ slugs: readonly string[]; at: number }> = [];
mock.module("../../v2/injection-events.js", () => ({
  recordInjectionEvents: (
    _db: unknown,
    slugs: readonly string[],
    at: number,
  ) => {
    recordCalls.push({ slugs, at });
  },
  computeInjectionScores: (
    _db: unknown,
    slugs: readonly string[],
    _now: number,
  ): Map<string, number> => new Map(slugs.map((s) => [s, 0])),
}));

// Database handle: the simulate route only passes this through to
// `runRouter` and `computeInjectionScores`. Both are stubbed above, so a
// sentinel object is sufficient.
mock.module("../../../../../persistence/db-connection.js", () => ({
  getDb: () => ({ __stub: true }),
  getSqlite: () => ({ __stub: true }),
  getSqliteFrom: () => ({ __stub: true }),
  getMemoryDb: () => ({ __stub: true }),
  getMemorySqlite: () => ({ __stub: true }),
  getLogsDb: () => ({ __stub: true }),
  getLogsSqlite: () => ({ __stub: true }),
  resetDb: () => {},
}));

// Config loader. The simulate route reads `memory.v2.enabled` (must be
// true) and the full `memory.v2.router` block (overrides merged on top).
const liveRouterConfig = {
  enabled: true,
  max_page_ids: 25,
  router_prompt_path: null,
  batch_size: null,
  tier1_size: null,
  tier2_size: null,
};
const mockConfigValue = {
  memory: {
    v2: {
      enabled: true,
      router: liveRouterConfig,
    },
  },
};
mock.module("../../../../../config/loader.js", () => ({
  loadConfig: () => mockConfigValue,
  getConfig: () => mockConfigValue,
  getConfigReadOnly: () => mockConfigValue,
  invalidateConfigCache: () => {},
  API_KEY_PROVIDERS: [],
}));

// Provider stub. Default returns [1, 2] (selects first two pages).
let providerStub: Provider | null = null;
interface ProviderCall {
  messages: Message[];
  tools: ToolDefinition[] | undefined;
  systemPrompt: string | undefined;
  options: SendMessageOptions | undefined;
}
const providerCalls: ProviderCall[] = [];
// The route imports `getConfiguredProvider` plus the identity reads
// (`getAssistantName`/`resolveUserName`, via the router) from
// `@vellumai/plugin-api`. Spread the real contract so the identity reads run
// (returning null on a missing IDENTITY.md in the temp workspace); override only
// `getConfiguredProvider`. The pure `extractToolUse` helper runs for real from
// the plugin's `llm-helpers`.
const realPluginApi = await import("@vellumai/plugin-api");
mock.module("@vellumai/plugin-api", () => ({
  ...realPluginApi,
  getConfiguredProvider: async () => providerStub,
}));

// Platform helpers. `getWorkspaceDir` must return the per-test tmp dir so
// the route's page index points at the test workspace.
let workspaceDir = "";
mock.module("../../../../../util/platform.js", () => {
  const stub = () => workspaceDir;
  return {
    getWorkspaceDir: () => workspaceDir,
    vellumRoot: stub,
    isMacOS: () => false,
    isLinux: () => true,
    isWindows: () => false,
    getPlatformName: () => "linux",
    normalizeAssistantId: (id: string) => id,
    getDataDir: stub,
    getEmbeddingModelsDir: stub,
    getSandboxRootDir: stub,
    getSandboxWorkingDir: stub,
    getSoundsDir: stub,
    getAvatarDir: stub,
    AVATAR_IMAGE_FILENAME: "avatar-image.png",
    getAvatarImagePath: stub,
    getXdgVellumConfigDirName: () => ".vellum",
    getPidPath: stub,
    getDbPath: stub,
    getLogsDir: stub,
    getHistoryPath: stub,
    getProtectedDir: stub,
    getSignalsDir: stub,
    getDaemonStderrLogPath: stub,
    getDaemonStartupLockPath: stub,
    getExternalDir: stub,
    getBinDir: stub,
    getDotEnvPath: stub,
    getEmbedWorkerPidPath: stub,
    getWorkspaceDirDisplay: stub,
    getWorkspaceConfigPath: stub,
    getWorkspaceSkillsDir: stub,
    getWorkspaceHooksDir: stub,
    getWorkspacePluginsDir: stub,
    getWorkspaceRoutesDir: stub,
    getDeprecatedDir: stub,
    getConversationsDir: stub,
    getWorkspacePromptPath: stub,
    getProfilerRootDir: stub,
    getProfilerRunsDir: stub,
    getProfilerRunDir: stub,
    ensureDataDir: () => {},
  };
});

// ---------------------------------------------------------------------------
// Import under test (after all mocks above)
// ---------------------------------------------------------------------------

const { handleSimulateRouter } = await import("../memory-v2-routes.js");
const { writePage } = await import("../../v2/page-store.js");
const { invalidatePageIndex } = await import("../../v2/page-index.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(pageIds: number[]): Provider {
  return {
    name: "stub",
    sendMessage: async (messages, options) => {
      providerCalls.push({
        messages,
        tools: options?.tools,
        systemPrompt: options?.systemPrompt,
        options,
      });
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
    },
  };
}

function makePage(slug: string, summary: string) {
  return {
    slug,
    frontmatter: {
      edges: [],
      ref_files: [],
      ref_urls: [],
      summary,
    },
    body: "",
  };
}

// ---------------------------------------------------------------------------
// Per-test setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "memory-v2-simulate-test-"));
  recordCalls.length = 0;
  providerCalls.length = 0;
  providerStub = null;
  // Reset live router config to defaults between tests.
  liveRouterConfig.batch_size = null;
  liveRouterConfig.tier1_size = null;
  liveRouterConfig.tier2_size = null;
  liveRouterConfig.max_page_ids = 25;
  invalidatePageIndex();
});

afterEach(() => {
  invalidatePageIndex();
  rmSync(workspaceDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleSimulateRouter", () => {
  test("returns selectedSlugs + sourceBySlug populated for each pick", async () => {
    await writePage(workspaceDir, makePage("alice", "A"));
    await writePage(workspaceDir, makePage("bob", "B"));
    await writePage(workspaceDir, makePage("carol", "C"));
    providerStub = makeProvider([3, 1]);

    const result = await handleSimulateRouter({
      body: {
        recentTurnPairs: [
          { assistantMessage: "", userMessage: "what's relevant?" },
        ],
      },
    });

    expect(result.failureReason).toBeNull();
    expect(result.selectedSlugs).toEqual(["carol", "alice"]);
    expect(result.sourceBySlug["carol"]).toBe("tier3:0");
    expect(result.sourceBySlug["alice"]).toBe("tier3:0");
    expect(result.scores["carol"]).toBe(0);
    expect(result.scores["alice"]).toBe(0);
    expect(result.totalCandidatePages).toBe(3);
  });

  test("propagates overrides into effectiveConfig and reports them in overrides", async () => {
    await writePage(workspaceDir, makePage("alice", "A"));
    providerStub = makeProvider([1]);

    const result = await handleSimulateRouter({
      body: {
        recentTurnPairs: [{ assistantMessage: "", userMessage: "test" }],
        configOverrides: {
          tier1_size: 50,
          batch_size: 25,
        },
      },
    });

    expect(result.effectiveConfig.tier1_size).toBe(50);
    expect(result.effectiveConfig.tier2_size).toBeNull(); // not overridden, inherits live
    expect(result.effectiveConfig.batch_size).toBe(25);
    expect(result.effectiveConfig.max_page_ids).toBe(25);
    expect(result.overrides).toEqual({ tier1_size: 50, batch_size: 25 });
  });

  test("never writes to the EMA event log (recordInjectionEvents not called)", async () => {
    await writePage(workspaceDir, makePage("alice", "A"));
    await writePage(workspaceDir, makePage("bob", "B"));
    providerStub = makeProvider([1, 2]);

    await handleSimulateRouter({
      body: {
        recentTurnPairs: [
          { assistantMessage: "", userMessage: "should not record" },
        ],
      },
    });

    expect(recordCalls).toEqual([]);
  });

  test("rejects an empty last-pair userMessage at the schema layer", async () => {
    await expect(
      handleSimulateRouter({
        body: { recentTurnPairs: [{ assistantMessage: "", userMessage: "" }] },
      }),
    ).rejects.toThrow();
  });

  test("rejects an empty recentTurnPairs array at the schema layer", async () => {
    await expect(
      handleSimulateRouter({ body: { recentTurnPairs: [] } }),
    ).rejects.toThrow();
  });

  test("rejects negative tier size at the schema layer", async () => {
    await expect(
      handleSimulateRouter({
        body: {
          recentTurnPairs: [{ assistantMessage: "", userMessage: "test" }],
          configOverrides: { tier1_size: -5 },
        },
      }),
    ).rejects.toThrow();
  });
});
