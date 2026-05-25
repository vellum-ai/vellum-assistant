/**
 * Route-assembly tests for the v3 retriever wiring in
 * `handleCompareRetrievers` (`assistant/src/runtime/routes/memory-v2-routes.ts`).
 *
 * The compare route always includes the router retriever as comparand #1 and
 * adds the v3 retriever as comparand #2 only when `config.memory.v3.enabled`.
 * These tests exercise that gating end-to-end through the real handler and the
 * real `runComparisonOverHistory`, with a fixture DB seeded with one logged
 * router turn (mirroring `assistant/src/memory/v2/__tests__/harness-compare.test.ts`).
 *
 * Neither the real router nor the real v3 loop runs here — both would hit a
 * provider. `../loop.js` (the v3 loop) and `../../v2/harness/router-retriever.js`
 * are `mock.module`-stubbed to return deterministic selections, so the tests
 * assert *which retrievers were assembled* (by the names in the report), not
 * their retrieval quality. `loadConfig` is stubbed so each test controls
 * `memory.v3.enabled`; workspace/page-index helpers are stubbed to keep the
 * handler off the filesystem.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantConfig } from "../../../config/types.js";
import { getDb } from "../../db-connection.js";
import { initializeDb } from "../../db-init.js";
import type { MemoryV2ConceptRowRecord } from "../../memory-v2-activation-log-store.js";
import {
  conversations,
  memoryV2ActivationLogs,
  messages,
} from "../../schema.js";
import type {
  RetrievalInput,
  RetrievalOutput,
} from "../../v2/harness/retriever.js";

initializeDb();

// Silence the route's logger.
mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// loadNowText / page-index read workspace files; a nonexistent dir yields "".
const WORKSPACE = "/tmp/v3-retriever-nonexistent-workspace";

// Controllable config: each test sets `v3Enabled` before invoking the handler.
let v3Enabled = false;

mock.module("../../../config/loader.js", () => ({
  loadConfig: (): AssistantConfig =>
    ({
      memory: {
        v2: { enabled: true, router: { historical_pairs: 1 } },
        v3: { enabled: v3Enabled },
      },
    }) as unknown as AssistantConfig,
}));

mock.module("../../../util/platform.js", () => ({
  getWorkspaceDir: (): string => WORKSPACE,
}));

// page-index is intentionally NOT mocked: it has a wide export surface
// (`invalidatePageIndex` etc.) that transitive importers in the route's
// dependency graph rely on, and `getPageIndex` over the nonexistent workspace
// returns a benign index. The retriever names are what we assert, not the
// page set, so the real (empty-ish) index is harmless here.

// Stub the router retriever — the real one calls a provider.
mock.module("../../v2/harness/router-retriever.js", () => ({
  createRouterRetriever: () => ({
    name: "router",
    retrieve: async (): Promise<RetrievalOutput> => ({
      selectedSlugs: ["p1"],
      sourceBySlug: new Map([["p1", "router"]]),
    }),
  }),
}));

// Stub the v3 loop — the real one runs scout/filter/tree/edge/gate lanes that
// hit providers, embeddings, and the filesystem.
mock.module("../loop.js", () => ({
  runRetrievalLoop: async (
    _input: RetrievalInput,
  ): Promise<RetrievalOutput> => ({
    selectedSlugs: ["p2"],
    sourceBySlug: new Map([["p2", "dense"]]),
  }),
}));

// Import the handler only after the mocks are installed.
const { handleCompareRetrievers } =
  await import("../../../runtime/routes/memory-v2-routes.js");

const ZERO_CONFIG = {
  d: 0,
  c_user: 0,
  c_assistant: 0,
  c_now: 0,
  k: 0,
  hops: 0,
  top_k: 0,
  epsilon: 0,
};

let seq = 0;

function ensureConversation(id: string): void {
  getDb()
    .insert(conversations)
    .values({ id, createdAt: 0, updatedAt: 0 })
    .onConflictDoNothing()
    .run();
}

function insertMessage(
  id: string,
  conversationId: string,
  role: string,
  text: string,
  createdAt: number,
): void {
  ensureConversation(conversationId);
  getDb()
    .insert(messages)
    .values({
      id,
      conversationId,
      role,
      content: JSON.stringify([{ type: "text", text }]),
      createdAt,
    })
    .run();
}

function makeConcept(
  slug: string,
  status: MemoryV2ConceptRowRecord["status"],
): MemoryV2ConceptRowRecord {
  return {
    slug,
    finalActivation: 0,
    ownActivation: 0,
    priorActivation: 0,
    simUser: 0,
    simAssistant: 0,
    simNow: 0,
    simUserRerankBoost: 0,
    simAssistantRerankBoost: 0,
    inRerankPool: false,
    spreadContribution: 0,
    source: "router",
    status,
  };
}

function insertRouterLog(
  conversationId: string,
  messageId: string,
  turn: number,
  concepts: MemoryV2ConceptRowRecord[],
  createdAt: number,
): void {
  ensureConversation(conversationId);
  getDb()
    .insert(memoryV2ActivationLogs)
    .values({
      id: `log-${seq++}`,
      conversationId,
      messageId,
      turn,
      mode: "router",
      conceptsJson: JSON.stringify(concepts),
      skillsJson: "[]",
      configJson: JSON.stringify(ZERO_CONFIG),
      createdAt,
    })
    .run();
}

/** Seed one router turn: user msg, assistant anchor, and the logged picks. */
function seedTurn(groundTruth: string[]): void {
  insertMessage("u1", "c1", "user", "hello", 10);
  insertMessage("a1", "c1", "assistant", "hi", 20); // anchor for turn 1
  insertRouterLog(
    "c1",
    "a1",
    1,
    groundTruth.map((slug) => makeConcept(slug, "injected")),
    20,
  );
}

function reset(): void {
  const db = getDb();
  db.delete(memoryV2ActivationLogs).run();
  db.delete(messages).run();
  v3Enabled = false;
}

describe("handleCompareRetrievers v3 wiring", () => {
  beforeEach(reset);

  test("includes only router when memory.v3.enabled is false", async () => {
    seedTurn(["p1", "p2"]);

    const report = await handleCompareRetrievers({ body: {} });

    const names = report.retrievers.map((r) => r.name);
    expect(names).toEqual(["router"]);
  });

  test("includes router and v3 when memory.v3.enabled is true", async () => {
    v3Enabled = true;
    seedTurn(["p1", "p2"]);

    const report = await handleCompareRetrievers({ body: {} });

    const names = report.retrievers.map((r) => r.name);
    expect(names).toEqual(["router", "v3"]);
    // Router is always comparand #1; v3 joins as comparand #2.
    expect(names[0]).toBe("router");
    expect(names[1]).toBe("v3");
  });
});
