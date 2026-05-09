/**
 * Tests for `assistant/src/memory/v2/migration.ts`.
 *
 * The migration is heavily LLM-dependent at runtime, but every stage is
 * structured so it can be unit-tested without a live provider:
 *
 *   - `gatherV1State`        — uses an in-memory SQLite DB seeded by the
 *     test (no real workspace DB, no `initializeDb`).
 *   - `clusterByTopic`       — pure function over `V1Item[]`.
 *   - `synthesizeConceptPage`— accepts a stub `Provider` so the test never
 *     reaches a real provider.
 *   - `derivePromotions`     — pure function.
 *   - `collapseEdges`        — pure function.
 *   - `enqueueEmbeds`        — exercised end-to-end via `runMemoryV2Migration`,
 *     which inserts rows into the test memory_jobs table.
 *
 * The end-to-end `runMemoryV2Migration` test stitches all stages together
 * with a stub provider, runs against an isolated mkdtemp workspace + an
 * in-memory DB, and asserts the on-disk side-effects (concept pages,
 * edges.json, promotions, sentinel) plus the enqueued embed jobs.
 *
 * Tests use temp workspaces (mkdtemp) and never touch `~/.vellum/`.
 * Sample content uses generic placeholders (Alice, Bob, user@example.com).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "../../../__tests__/helpers/mock-logger.js";
import type { Provider, ProviderResponse } from "../../../providers/types.js";

// -- Mocks that must be installed before importing the module under test ---
//
// Order matters: every `mock.module` here runs before the migration module is
// imported below, so its top-level `getLogger`/`getConfiguredProvider`/
// `enqueueMemoryJob` references resolve to our stubs. Reversing the order
// lets the real implementations leak through.
mock.module("../../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

// `runMemoryV2Migration` calls `enqueueMemoryJob` which in turn calls
// `getDb()`. We intercept the enqueue call so the test doesn't need to wire
// up the full migration runner / data-dir scaffolding just to count
// enqueues. The stub records every (type, payload) pair for assertion.
const enqueuedJobs: Array<{ type: string; payload: Record<string, unknown> }> =
  [];
mock.module("../../jobs-store.js", () => ({
  enqueueMemoryJob: (type: string, payload: Record<string, unknown>) => {
    enqueuedJobs.push({ type, payload });
    return `job-${enqueuedJobs.length}`;
  },
}));

// `getConfiguredProvider` is invoked when the runner is called without an
// explicit `provider` arg. Our top-level runner test always passes a stub
// provider, but the safety net mock keeps any accidental real-call from
// reaching the network — and lets us add a "no provider configured" test.
let providerStub: Provider | null = null;
mock.module("../../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => providerStub,
  userMessage: (text: string) => ({
    role: "user" as const,
    content: [{ type: "text" as const, text }],
  }),
  extractText: (response: ProviderResponse) => {
    const block = response.content.find(
      (b): b is { type: "text"; text: string } => b.type === "text",
    );
    return block?.text?.trim() ?? "";
  },
}));

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { drizzle } from "drizzle-orm/bun-sqlite";

import type { DrizzleDb } from "../../db-connection.js";
import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
// Type-only imports are erased at runtime so they don't evaluate the module —
// safe to declare alongside the dynamic value import below.
import type { Cluster, V1Edge, V1Item } from "../migration.js";

// Dynamic import — runs *after* the mock.module calls above so the migration
// module's transitive references to logger / jobs-store / provider-send-message
// resolve to our stubs (matches the pattern used in `qdrant.test.ts`).
const {
  clusterByTopic,
  collapseEdges,
  derivePromotions,
  enqueueEmbeds,
  gatherV1State,
  MIGRATION_SENTINEL_RELATIVE,
  MigrationAlreadyAppliedError,
  runMemoryV2Migration,
  synthesizeConceptPage,
} = await import("../migration.js");

// ---------------------------------------------------------------------------
// Test fixtures + helpers
// ---------------------------------------------------------------------------

let workspaceDir: string;
let database: DrizzleDb;
let sqlite: Database;

beforeEach(() => {
  workspaceDir = mkdtempSync(
    join(tmpdir(), "vellum-memory-v2-migration-test-"),
  );
  mkdirSync(join(workspaceDir, "memory", "concepts"), { recursive: true });
  mkdirSync(join(workspaceDir, "memory", "archive"), { recursive: true });
  mkdirSync(join(workspaceDir, "memory", ".v2-state"), { recursive: true });
  mkdirSync(join(workspaceDir, "pkb"), { recursive: true });

  sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  database = drizzle(sqlite, { schema });

  // Minimal schema — only the v1 tables the migration reads from. We don't
  // need the full memory schema; reading is unaffected by indexes / FKs we
  // don't seed.
  getSqliteFrom(database).exec(/*sql*/ `
    CREATE TABLE memory_graph_nodes (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      type TEXT NOT NULL,
      created INTEGER NOT NULL,
      last_accessed INTEGER NOT NULL,
      last_consolidated INTEGER NOT NULL,
      event_date INTEGER,
      emotional_charge TEXT NOT NULL,
      fidelity TEXT NOT NULL DEFAULT 'vivid',
      confidence REAL NOT NULL,
      significance REAL NOT NULL,
      stability REAL NOT NULL DEFAULT 14,
      reinforcement_count INTEGER NOT NULL DEFAULT 0,
      last_reinforced INTEGER NOT NULL,
      source_conversations TEXT NOT NULL DEFAULT '[]',
      source_type TEXT NOT NULL DEFAULT 'inferred',
      narrative_role TEXT,
      part_of_story TEXT,
      scope_id TEXT NOT NULL DEFAULT 'default',
      image_refs TEXT
    );
    CREATE TABLE memory_graph_edges (
      id TEXT PRIMARY KEY,
      source_node_id TEXT NOT NULL,
      target_node_id TEXT NOT NULL,
      relationship TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      created INTEGER NOT NULL
    );
  `);

  enqueuedJobs.length = 0;
  providerStub = null;
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
  sqlite.close();
});

/** Insert one v1 graph node row. Defaults match a "remember-this fact" shape. */
function insertNode(
  database: DrizzleDb,
  overrides: Partial<{
    id: string;
    content: string;
    type: string;
    significance: number;
    eventDate: number | null;
  }> = {},
): string {
  const id = overrides.id ?? `node-${Math.random().toString(36).slice(2, 10)}`;
  getSqliteFrom(database)
    .query(
      /*sql*/ `INSERT INTO memory_graph_nodes (
        id, content, type, created, last_accessed, last_consolidated,
        event_date, emotional_charge, confidence, significance, last_reinforced
      ) VALUES (?, ?, ?, 0, 0, 0, ?, '{}', 0.9, ?, 0)`,
    )
    .run(
      id,
      overrides.content ?? "Alice prefers VS Code over Vim.",
      overrides.type ?? "semantic",
      overrides.eventDate ?? null,
      overrides.significance ?? 0.5,
    );
  return id;
}

function insertEdge(
  database: DrizzleDb,
  sourceId: string,
  targetId: string,
): void {
  getSqliteFrom(database)
    .query(
      /*sql*/ `INSERT INTO memory_graph_edges (
        id, source_node_id, target_node_id, relationship, weight, created
      ) VALUES (?, ?, ?, 'reminds-of', 0.7, 0)`,
    )
    .run(`edge-${Math.random().toString(36).slice(2, 10)}`, sourceId, targetId);
}

/** Build a `Provider` that returns canned text per call. */
function buildStubProvider(textPerCall: string[] | string): Provider {
  const queue = Array.isArray(textPerCall) ? [...textPerCall] : null;
  return {
    name: "stub",
    sendMessage: async () => {
      const text = queue ? (queue.shift() ?? "") : (textPerCall as string);
      return {
        content: [{ type: "text", text }],
        model: "stub-model",
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
      };
    },
  };
}

// ---------------------------------------------------------------------------
// gatherV1State
// ---------------------------------------------------------------------------

describe("gatherV1State", () => {
  test("returns empty state for an empty workspace + empty DB", () => {
    const { items, edges } = gatherV1State(database, workspaceDir);
    expect(items).toEqual([]);
    expect(edges).toEqual([]);
  });

  test("reads graph nodes from the v1 store", () => {
    const id = insertNode(database, {
      content: "Alice ships to Vellum at end of day.",
      type: "semantic",
      significance: 0.8,
    });
    const { items } = gatherV1State(database, workspaceDir);
    expect(items.length).toBe(1);
    expect(items[0]).toMatchObject({
      id,
      text: "Alice ships to Vellum at end of day.",
      source: "graph_node",
      significance: 0.8,
      type: "semantic",
    });
  });

  test("reads graph edges from the v1 store", () => {
    const a = insertNode(database, { id: "node-a" });
    const b = insertNode(database, { id: "node-b" });
    insertEdge(database, a, b);
    const { edges } = gatherV1State(database, workspaceDir);
    expect(edges.length).toBe(1);
    expect(edges[0]).toEqual({
      sourceNodeId: "node-a",
      targetNodeId: "node-b",
    });
  });

  test("reads pkb/buffer.md", () => {
    writeFileSync(
      join(workspaceDir, "pkb", "buffer.md"),
      "- Alice's preferred IDE is VS Code\n",
      "utf-8",
    );
    const { items } = gatherV1State(database, workspaceDir);
    const buffer = items.find((i) => i.source === "pkb_buffer");
    expect(buffer).toBeDefined();
    expect(buffer?.text).toBe("- Alice's preferred IDE is VS Code\n");
  });

  test("reads pkb/archive/*.md and pkb/<topic>.md files", () => {
    mkdirSync(join(workspaceDir, "pkb", "archive"), { recursive: true });
    writeFileSync(
      join(workspaceDir, "pkb", "archive", "2026-01-01.md"),
      "Archive content for Bob.\n",
      "utf-8",
    );
    writeFileSync(
      join(workspaceDir, "pkb", "ides.md"),
      "VS Code is preferred.\n",
      "utf-8",
    );
    const { items } = gatherV1State(database, workspaceDir);
    expect(items.find((i) => i.source === "pkb_archive")).toMatchObject({
      sourcePath: "pkb/archive/2026-01-01.md",
    });
    expect(items.find((i) => i.source === "pkb_topic")).toMatchObject({
      sourcePath: "pkb/ides.md",
    });
  });

  test("ignores non-.md files in pkb/ and pkb/archive/", () => {
    mkdirSync(join(workspaceDir, "pkb", "archive"), { recursive: true });
    writeFileSync(join(workspaceDir, "pkb", "ignored.txt"), "skip me", "utf-8");
    writeFileSync(
      join(workspaceDir, "pkb", "archive", "junk.bin"),
      "skip me",
      "utf-8",
    );
    const { items } = gatherV1State(database, workspaceDir);
    expect(items.filter((i) => i.source !== "graph_node")).toEqual([]);
  });

  test("gracefully handles a missing pkb/ directory", () => {
    rmSync(join(workspaceDir, "pkb"), { recursive: true, force: true });
    expect(() => gatherV1State(database, workspaceDir)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// clusterByTopic
// ---------------------------------------------------------------------------

describe("clusterByTopic", () => {
  test("emits one cluster per item in input order", () => {
    const items: V1Item[] = [
      buildItem({ id: "n1", text: "Alice IDE preference is VS Code" }),
      buildItem({ id: "n2", text: "Bob coffee order is double espresso" }),
    ];
    const clusters = clusterByTopic(items);
    expect(clusters.length).toBe(2);
    expect(clusters[0].items[0].id).toBe("n1");
    expect(clusters[1].items[0].id).toBe("n2");
  });

  test("topic file → slug-hint matches filename", () => {
    const items: V1Item[] = [
      buildItem({
        id: "pkb:topic:ides.md",
        text: "VS Code preferred",
        source: "pkb_topic",
        sourcePath: "pkb/ides.md",
      }),
    ];
    const [cluster] = clusterByTopic(items);
    expect(cluster.slugHint).toBe("ides");
  });

  test("archive entry → slug hint includes the date stamp", () => {
    const items: V1Item[] = [
      buildItem({
        id: "pkb:archive:2026-01-01.md",
        text: "x",
        source: "pkb_archive",
        sourcePath: "pkb/archive/2026-01-01.md",
      }),
    ];
    const [cluster] = clusterByTopic(items);
    expect(cluster.slugHint).toBe("archive-2026-01-01");
  });

  test("graph node → slug hint is first few words of content", () => {
    const items: V1Item[] = [
      buildItem({
        id: "node-1",
        text: "Alice prefers VS Code over Vim and ships at end of day.",
      }),
    ];
    const [cluster] = clusterByTopic(items);
    // Punctuation survives the hint stage; slugify in stage 3 strips it.
    expect(cluster.slugHint).toBe("Alice-prefers-VS-Code-over-Vim");
  });
});

// ---------------------------------------------------------------------------
// synthesizeConceptPage
// ---------------------------------------------------------------------------

describe("synthesizeConceptPage", () => {
  test("returns a ConceptPage built from the provider's text response", async () => {
    const cluster: Cluster = {
      slugHint: "alice-ides",
      items: [
        buildItem({
          id: "node-1",
          text: "Alice prefers VS Code over Vim.",
        }),
      ],
    };
    const provider = buildStubProvider(
      "Alice prefers VS Code. She ships at end of day.",
    );
    const page = await synthesizeConceptPage(cluster, null, provider);
    expect(page.slug).toBe("alice-ides");
    expect(page.frontmatter).toEqual({ edges: [], ref_files: [] });
    expect(page.body).toContain("VS Code");
    expect(page.body.endsWith("\n")).toBe(true);
  });

  test("appends identity context to the system prompt when provided", async () => {
    let capturedSystem: string | undefined;
    const provider: Provider = {
      name: "stub",
      sendMessage: async (_messages, _tools, system) => {
        capturedSystem = system;
        return {
          content: [{ type: "text", text: "synthesized" }],
          model: "stub-model",
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: "end_turn",
        };
      },
    };
    await synthesizeConceptPage(
      {
        slugHint: "x",
        items: [buildItem({ id: "node-1", text: "fact" })],
      },
      "I am the example assistant. Be precise.",
      provider,
    );
    expect(capturedSystem).toContain("I am the example assistant.");
  });

  test("normalizes the slug via slugify", async () => {
    const provider = buildStubProvider("body");
    const page = await synthesizeConceptPage(
      {
        slugHint: "ALICE!! Preferences!!",
        items: [buildItem({ id: "node-1", text: "x" })],
      },
      null,
      provider,
    );
    expect(page.slug).toBe("alice-preferences");
  });
});

// ---------------------------------------------------------------------------
// derivePromotions
// ---------------------------------------------------------------------------

describe("derivePromotions", () => {
  test("high significance → essentials", () => {
    const items: V1Item[] = [
      buildItem({
        id: "n1",
        text: "User's name is Alice",
        significance: 0.95,
      }),
    ];
    const result = derivePromotions(items);
    expect(result.essentials).toEqual(["- User's name is Alice"]);
    expect(result.threads).toEqual([]);
    expect(result.archive).toEqual([]);
  });

  test("prospective type → threads (regardless of significance)", () => {
    const items: V1Item[] = [
      buildItem({
        id: "n1",
        text: "Follow up with Bob next Tuesday",
        significance: 0.5,
        type: "prospective",
      }),
    ];
    const result = derivePromotions(items);
    expect(result.threads).toEqual(["- Follow up with Bob next Tuesday"]);
    expect(result.essentials).toEqual([]);
    expect(result.archive).toEqual([]);
  });

  test("low significance → archive", () => {
    const items: V1Item[] = [
      buildItem({
        id: "n1",
        text: "Random small detail",
        significance: 0.1,
      }),
    ];
    const result = derivePromotions(items);
    expect(result.archive).toEqual(["- Random small detail"]);
    expect(result.essentials).toEqual([]);
    expect(result.threads).toEqual([]);
  });

  test("middle significance → no promotion (concept page only)", () => {
    const items: V1Item[] = [
      buildItem({
        id: "n1",
        text: "Mid-significance fact",
        significance: 0.5,
      }),
    ];
    const result = derivePromotions(items);
    expect(result.essentials).toEqual([]);
    expect(result.threads).toEqual([]);
    expect(result.archive).toEqual([]);
  });

  test("PKB items are never promoted (concept page only)", () => {
    const items: V1Item[] = [
      buildItem({
        id: "pkb:buffer",
        text: "Alice's preferred IDE is VS Code",
        source: "pkb_buffer",
        significance: 0,
      }),
    ];
    const result = derivePromotions(items);
    expect(result.essentials).toEqual([]);
    expect(result.threads).toEqual([]);
    expect(result.archive).toEqual([]);
  });

  test("essentials threshold takes precedence over prospective", () => {
    // High-significance prospective node is essential first; threads is the
    // bucket for *active* follow-ups, not core identity.
    const items: V1Item[] = [
      buildItem({
        id: "n1",
        text: "User is undergoing therapy and remembers everything",
        significance: 0.95,
        type: "prospective",
      }),
    ];
    const result = derivePromotions(items);
    expect(result.essentials.length).toBe(1);
    expect(result.threads).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// collapseEdges
// ---------------------------------------------------------------------------

describe("collapseEdges", () => {
  test("maps v1 ids to v2 slugs and preserves direction (source → target)", () => {
    const v1: V1Edge[] = [
      { sourceNodeId: "node-a", targetNodeId: "node-b" },
      { sourceNodeId: "node-b", targetNodeId: "node-c" },
    ];
    const slugMap = new Map([
      ["node-a", "alice"],
      ["node-b", "bob"],
      ["node-c", "carol"],
    ]);
    const outgoing = collapseEdges(v1, slugMap);
    // Two distinct sources, each pointing at one target.
    expect(outgoing.size).toBe(2);
    expect([...(outgoing.get("alice") ?? new Set<string>())]).toEqual(["bob"]);
    expect([...(outgoing.get("bob") ?? new Set<string>())]).toEqual(["carol"]);
    // Direction is preserved — carol's outgoing list is empty (it's a sink).
    expect(outgoing.has("carol")).toBe(false);
  });

  test("drops edges whose endpoints aren't in the slug map", () => {
    const v1: V1Edge[] = [
      { sourceNodeId: "node-a", targetNodeId: "ghost" },
      { sourceNodeId: "ghost", targetNodeId: "node-b" },
    ];
    const slugMap = new Map([
      ["node-a", "alice"],
      ["node-b", "bob"],
    ]);
    const outgoing = collapseEdges(v1, slugMap);
    expect(outgoing.size).toBe(0);
  });

  test("drops self-loops introduced by the slug mapping", () => {
    // Two distinct v1 nodes mapped to the same v2 slug (e.g. clustered
    // together) cannot produce a self-edge — concept-page graphs are simple,
    // so we filter at collapse time.
    const v1: V1Edge[] = [{ sourceNodeId: "node-a", targetNodeId: "node-b" }];
    const slugMap = new Map([
      ["node-a", "merged"],
      ["node-b", "merged"],
    ]);
    const outgoing = collapseEdges(v1, slugMap);
    expect(outgoing.size).toBe(0);
  });

  test("collapses duplicate (source, target) pairs into a single entry", () => {
    const v1: V1Edge[] = [
      { sourceNodeId: "node-a", targetNodeId: "node-b" },
      { sourceNodeId: "node-a", targetNodeId: "node-b" },
    ];
    const slugMap = new Map([
      ["node-a", "alice"],
      ["node-b", "bob"],
    ]);
    const outgoing = collapseEdges(v1, slugMap);
    expect([...(outgoing.get("alice") ?? new Set<string>())]).toEqual(["bob"]);
  });

  test("keeps A→B and B→A as separate directed edges", () => {
    const v1: V1Edge[] = [
      { sourceNodeId: "node-a", targetNodeId: "node-b" },
      { sourceNodeId: "node-b", targetNodeId: "node-a" },
    ];
    const slugMap = new Map([
      ["node-a", "alice"],
      ["node-b", "bob"],
    ]);
    const outgoing = collapseEdges(v1, slugMap);
    expect([...(outgoing.get("alice") ?? new Set<string>())]).toEqual(["bob"]);
    expect([...(outgoing.get("bob") ?? new Set<string>())]).toEqual(["alice"]);
  });
});

// ---------------------------------------------------------------------------
// enqueueEmbeds
// ---------------------------------------------------------------------------

describe("enqueueEmbeds", () => {
  test("enqueues one embed_concept_page job per slug", () => {
    expect(enqueueEmbeds(["alice", "bob", "carol"], database)).toBe(3);
    expect(enqueuedJobs).toEqual([
      { type: "embed_concept_page", payload: { slug: "alice" } },
      { type: "embed_concept_page", payload: { slug: "bob" } },
      { type: "embed_concept_page", payload: { slug: "carol" } },
    ]);
  });

  test("empty list is a no-op", () => {
    expect(enqueueEmbeds([], database)).toBe(0);
    expect(enqueuedJobs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runMemoryV2Migration (end-to-end)
// ---------------------------------------------------------------------------

describe("runMemoryV2Migration", () => {
  test("end-to-end: gathers, synthesizes, promotes, collapses, embeds, sentinel", async () => {
    const a = insertNode(database, {
      id: "node-a",
      content: "User is Alice and works at Vellum",
      significance: 0.95,
    });
    const b = insertNode(database, {
      id: "node-b",
      content: "Alice prefers VS Code over Vim",
      significance: 0.5,
    });
    insertEdge(database, a, b);
    writeFileSync(
      join(workspaceDir, "pkb", "ides.md"),
      "VS Code is preferred at Vellum.\n",
      "utf-8",
    );

    const provider = buildStubProvider([
      "Alice works at Vellum.\n",
      "Alice prefers VS Code over Vim.\n",
      "VS Code is preferred at Vellum.\n",
    ]);
    const result = await runMemoryV2Migration({
      workspaceDir,
      database,
      provider,
    });

    // -- Pages were written. --
    const conceptDir = join(workspaceDir, "memory", "concepts");
    const pages = readdirSync(conceptDir);
    expect(pages.length).toBe(3);
    expect(result.pagesCreated).toBe(3);

    // -- Outgoing edges live in source-page frontmatter (no edges.json). --
    expect(existsSync(join(workspaceDir, "memory", "edges.json"))).toBe(false);
    expect(result.edgesWritten).toBe(1);
    // Find the page whose frontmatter has the outgoing edge — that's the
    // source slug. Exactly one page should carry the surviving v1 edge.
    let pagesWithEdges = 0;
    for (const file of pages) {
      const body = readFileSync(join(conceptDir, file), "utf-8");
      if (
        /\nedges:\s*\n?\s*-\s*/.test(body) ||
        /edges:\s*\[[^\]]+\]/.test(body)
      ) {
        pagesWithEdges += 1;
      }
    }
    expect(pagesWithEdges).toBe(1);

    // -- Promotions appended to the right files. --
    const essentials = readFileSync(
      join(workspaceDir, "memory", "essentials.md"),
      "utf-8",
    );
    expect(essentials).toContain("User is Alice and works at Vellum");
    expect(result.essentialsLines).toBe(1);

    // -- Embed jobs enqueued (one per page). No rebuild-edges follow-up:
    //    the migration writes outgoing edges directly into page frontmatter. --
    expect(enqueuedJobs.length).toBe(3);
    const embedJobs = enqueuedJobs.filter(
      (j) => j.type === "embed_concept_page",
    );
    expect(embedJobs.length).toBe(3);

    // -- Sentinel written. --
    expect(existsSync(join(workspaceDir, MIGRATION_SENTINEL_RELATIVE))).toBe(
      true,
    );
    expect(result.sentinelWritten).toBe(true);
  });

  test("rejects re-run when sentinel exists and force is not set", async () => {
    const provider = buildStubProvider("body");
    insertNode(database, { content: "fact" });
    await runMemoryV2Migration({ workspaceDir, database, provider });

    await expect(
      runMemoryV2Migration({ workspaceDir, database, provider }),
    ).rejects.toThrow(MigrationAlreadyAppliedError);
  });

  test("force=true overwrites and re-writes the sentinel", async () => {
    insertNode(database, { content: "fact" });
    const provider1 = buildStubProvider("first body");
    await runMemoryV2Migration({ workspaceDir, database, provider: provider1 });

    const provider2 = buildStubProvider("second body");
    const result = await runMemoryV2Migration({
      workspaceDir,
      database,
      provider: provider2,
      force: true,
    });
    expect(result.sentinelWritten).toBe(true);

    const conceptDir = join(workspaceDir, "memory", "concepts");
    const pages = readdirSync(conceptDir);
    expect(pages.length).toBe(1);
    const body = readFileSync(join(conceptDir, pages[0]), "utf-8");
    expect(body).toContain("second body");
  });

  test("clearing the sentinel allows a non-force re-run", async () => {
    insertNode(database, { content: "fact" });
    const provider = buildStubProvider("body");
    await runMemoryV2Migration({ workspaceDir, database, provider });
    unlinkSync(join(workspaceDir, MIGRATION_SENTINEL_RELATIVE));
    // No throw.
    await runMemoryV2Migration({
      workspaceDir,
      database,
      provider: buildStubProvider("rerun"),
    });
  });

  test("throws when no provider is available and none is configured", async () => {
    insertNode(database, { content: "fact" });
    providerStub = null;
    await expect(
      runMemoryV2Migration({ workspaceDir, database }),
    ).rejects.toThrow(/memoryV2Migration provider unavailable/);
  });

  test("uses getConfiguredProvider when no provider is passed", async () => {
    insertNode(database, { content: "fact" });
    providerStub = buildStubProvider("body from configured provider");
    const result = await runMemoryV2Migration({ workspaceDir, database });
    expect(result.pagesCreated).toBe(1);
    const conceptDir = join(workspaceDir, "memory", "concepts");
    const body = readFileSync(
      join(conceptDir, readdirSync(conceptDir)[0]),
      "utf-8",
    );
    expect(body).toContain("body from configured provider");
  });

  test("disambiguates colliding slugs with -2/-3 suffixes", async () => {
    insertNode(database, {
      id: "n1",
      content: "Alice IDE preferences",
      significance: 0.5,
    });
    insertNode(database, {
      id: "n2",
      content: "Alice IDE preferences",
      significance: 0.5,
    });
    const provider = buildStubProvider(["body 1", "body 2"]);
    await runMemoryV2Migration({ workspaceDir, database, provider });

    const conceptDir = join(workspaceDir, "memory", "concepts");
    const pages = new Set(readdirSync(conceptDir));
    expect(pages.size).toBe(2);
    // First page wins the bare slug; second gets the `-2` suffix.
    expect(pages.has("alice-ide-preferences.md")).toBe(true);
    expect(pages.has("alice-ide-preferences-2.md")).toBe(true);
  });

  test("dry workspace + empty DB still writes sentinel and produces zero pages", async () => {
    const provider = buildStubProvider("");
    const result = await runMemoryV2Migration({
      workspaceDir,
      database,
      provider,
    });
    expect(result.pagesCreated).toBe(0);
    expect(result.embedsEnqueued).toBe(0);
    expect(result.edgesWritten).toBe(0);
    expect(result.sentinelWritten).toBe(true);
    // No rebuild-edges follow-up — outgoing edges live directly in page
    // frontmatter, so a workspace with no pages has nothing to rebuild.
    expect(enqueuedJobs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildItem(overrides: Partial<V1Item> = {}): V1Item {
  return {
    id: overrides.id ?? "node-default",
    text: overrides.text ?? "default content",
    source: overrides.source ?? "graph_node",
    significance: overrides.significance ?? 0.5,
    type: overrides.type ?? "semantic",
    eventDate: overrides.eventDate ?? null,
    sourcePath: overrides.sourcePath ?? null,
  };
}
