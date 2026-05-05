/**
 * Tests for `assistant/src/memory/context-search/sources/memory-v2.ts`.
 *
 * Covers the recall-side adapter the `memory` source delegates to when the
 * v2 flag is on. Two retrieval paths run in parallel:
 *   - Activation + 2-hop spreading over the v2 concept-page Qdrant collection.
 *   - Lexical file-search fallback over `<workspace>/memory/concepts/*.md`.
 *
 * The activation path is exercised by mocking `hybridQueryConceptPages`,
 * `getEdgeIndex`, and `readPage`. The lexical fallback is exercised against
 * a real temp workspace so its directory walk and term scoring run end-to-end.
 *
 * Generic placeholders (`alice`, `bob`, etc.) per the cross-cutting safety
 * rules. Tests are hermetic — no live Qdrant, no embedding backend round-trip.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantConfig } from "../config/schema.js";
import type { RecallSearchContext } from "../memory/context-search/types.js";
import type { EdgeIndex } from "../memory/v2/edge-index.js";
import type { ConceptPage } from "../memory/v2/types.js";
import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

let denseEmbedReturn: number[] = [0.1, 0.2, 0.3];
mock.module("../memory/embedding-backend.js", () => ({
  embedWithBackend: async () => ({
    provider: "test",
    model: "test-model",
    vectors: [denseEmbedReturn],
  }),
  generateSparseEmbedding: () => ({ indices: [1], values: [1] }),
}));

interface QdrantHit {
  slug: string;
  denseScore?: number;
  sparseScore?: number;
}

let qdrantHits: QdrantHit[] = [];
let qdrantThrows: Error | null = null;
const qdrantCalls: Array<{ limit: number }> = [];

mock.module("../memory/v2/qdrant.js", () => ({
  hybridQueryConceptPages: async (
    _dense: number[],
    _sparse: { indices: number[]; values: number[] },
    limit: number,
  ): Promise<QdrantHit[]> => {
    qdrantCalls.push({ limit });
    if (qdrantThrows) throw qdrantThrows;
    return qdrantHits;
  },
}));

let edgeIndex: EdgeIndex = {
  outgoing: new Map<string, Set<string>>(),
  incoming: new Map<string, Set<string>>(),
};

mock.module("../memory/v2/edge-index.js", () => ({
  getEdgeIndex: async (): Promise<EdgeIndex> => edgeIndex,
  invalidateEdgeIndex: () => {},
  getReachable: () => new Set<string>(),
  validateEdgeTargets: () => ({ ok: true, missing: [] }),
  totalEdgeCount: () => 0,
}));

const pageStore = new Map<string, ConceptPage>();

mock.module("../memory/v2/page-store.js", () => ({
  getConceptsDir: (workspaceDir: string): string =>
    join(workspaceDir, "memory", "concepts"),
  listPages: async (): Promise<string[]> => [...pageStore.keys()],
  readPage: async (
    _workspaceDir: string,
    slug: string,
  ): Promise<ConceptPage | null> => pageStore.get(slug) ?? null,
  writePage: async () => {},
  deletePage: async () => {},
  slugFromConceptPath: (conceptsRoot: string, filePath: string): string => {
    const rel = filePath.startsWith(conceptsRoot)
      ? filePath.slice(conceptsRoot.length).replace(/^\/+/, "")
      : filePath;
    return rel.endsWith(".md") ? rel.slice(0, -3) : rel;
  },
  validateSlug: () => {},
}));

const { searchMemoryV2Source } =
  await import("../memory/context-search/sources/memory-v2.js");

const testDirs: string[] = [];

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "context-search-memory-v2-")),
  );
  testDirs.push(dir);
  return dir;
}

function writeFile(root: string, relativePath: string, body: string): void {
  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, body);
}

function writeConceptPage(root: string, slug: string, body: string): void {
  writeFile(
    root,
    `memory/concepts/${slug}.md`,
    `---\nedges: []\nref_files: []\n---\n${body}`,
  );
}

function makeConfig(): AssistantConfig {
  return {
    memory: {
      v2: {
        enabled: true,
        dense_weight: 0.6,
        sparse_weight: 0.4,
        k: 0.5,
        hops: 2,
        epsilon: 0.05,
        d: 0.5,
        c_user: 1,
        c_assistant: 0.5,
        c_now: 0.5,
        top_k: 8,
        top_k_skills: 0,
      },
    },
  } as unknown as AssistantConfig;
}

function makeContext(workingDir: string): RecallSearchContext {
  return {
    workingDir,
    conversationId: "conv-test",
    config: makeConfig(),
  };
}

beforeEach(() => {
  qdrantHits = [];
  qdrantThrows = null;
  qdrantCalls.length = 0;
  edgeIndex = {
    outgoing: new Map<string, Set<string>>(),
    incoming: new Map<string, Set<string>>(),
  };
  pageStore.clear();
  denseEmbedReturn = [0.1, 0.2, 0.3];
});

describe("searchMemoryV2Source", () => {
  test("returns activation evidence with memory/concepts/<slug>.md locators", async () => {
    const root = makeTempDir();
    writeConceptPage(root, "alice", "Alice prefers concise notes.\n");

    qdrantHits = [{ slug: "alice", denseScore: 0.9 }];
    pageStore.set("alice", {
      slug: "alice",
      frontmatter: { edges: [], ref_files: [] },
      body: "Alice prefers concise notes.",
    });

    const result = await searchMemoryV2Source("alice", makeContext(root), 5);

    expect(result.evidence.length).toBeGreaterThan(0);
    const activationHit = result.evidence.find(
      (e) => e.metadata?.retrieval === "activation",
    );
    expect(activationHit).toBeDefined();
    expect(activationHit?.locator).toBe("memory/concepts/alice.md");
    expect(activationHit?.title).toBe("alice");
    expect(activationHit?.excerpt).toContain("Alice prefers concise notes");
    expect(activationHit?.metadata?.path).toBe("memory/concepts/alice.md");
    expect(activationHit?.metadata?.slug).toBe("alice");
    expect(qdrantCalls.length).toBeGreaterThan(0);
  });

  test("falls back to lexical evidence when activation finds nothing", async () => {
    const root = makeTempDir();
    writeConceptPage(
      root,
      "bob",
      "# Bob\n\nBob's birthday party plans for next month.\n",
    );

    qdrantHits = [];

    const result = await searchMemoryV2Source(
      "birthday party",
      makeContext(root),
      5,
    );

    expect(result.evidence.length).toBeGreaterThan(0);
    const lexicalHit = result.evidence.find(
      (e) => e.metadata?.retrieval === "lexical",
    );
    expect(lexicalHit).toBeDefined();
    expect(lexicalHit?.metadata?.path).toBe("memory/concepts/bob.md");
    expect(lexicalHit?.locator).toMatch(/^memory\/concepts\/bob\.md:\d+$/);
    expect(lexicalHit?.excerpt).toContain("birthday");
  });

  test("returns lexical evidence when Qdrant is unavailable", async () => {
    const root = makeTempDir();
    writeConceptPage(
      root,
      "carol",
      "# Carol\n\nCarol joined the launch checklist review.\n",
    );

    qdrantThrows = new Error("qdrant unavailable");

    const result = await searchMemoryV2Source(
      "launch checklist",
      makeContext(root),
      5,
    );

    expect(result.evidence.length).toBeGreaterThan(0);
    expect(
      result.evidence.every((e) => e.metadata?.retrieval === "lexical"),
    ).toBe(true);
  });

  test("returns empty when neither activation nor lexical matches anything", async () => {
    const root = makeTempDir();
    qdrantHits = [];
    // No concept pages on disk

    const result = await searchMemoryV2Source("anything", makeContext(root), 5);

    expect(result.evidence).toEqual([]);
  });

  test("handles a missing memory/concepts directory gracefully", async () => {
    const root = makeTempDir(); // workspace exists, but no memory/ dir
    qdrantHits = [];

    const result = await searchMemoryV2Source(
      "no concepts",
      makeContext(root),
      5,
    );

    expect(result.evidence).toEqual([]);
  });

  test("respects the recall limit", async () => {
    const root = makeTempDir();
    for (let i = 0; i < 5; i++) {
      const slug = `concept-${i}`;
      writeConceptPage(
        root,
        slug,
        `# ${slug}\n\nbirthday party reminder ${i}\n`,
      );
    }

    qdrantHits = [];

    const result = await searchMemoryV2Source(
      "birthday party",
      makeContext(root),
      2,
    );

    expect(result.evidence.length).toBeLessThanOrEqual(2);
  });

  test("activation hits use slug as title and full body as excerpt", async () => {
    const root = makeTempDir();
    pageStore.set("alice", {
      slug: "alice",
      frontmatter: { edges: [], ref_files: [] },
      body: "Alice memory body content.",
    });
    qdrantHits = [{ slug: "alice", denseScore: 0.85 }];

    const result = await searchMemoryV2Source(
      "alice memory",
      makeContext(root),
      5,
    );

    const hit = result.evidence.find(
      (e) => e.metadata?.retrieval === "activation",
    );
    expect(hit?.title).toBe("alice");
    expect(hit?.excerpt).toBe("Alice memory body content.");
  });

  test("activation hit for nested slug produces nested locator and slug", async () => {
    const root = makeTempDir();
    writeConceptPage(root, "people/alice", "Alice prefers concise notes.\n");

    qdrantHits = [{ slug: "people/alice", denseScore: 0.92 }];
    pageStore.set("people/alice", {
      slug: "people/alice",
      frontmatter: { edges: [], ref_files: [] },
      body: "Alice prefers concise notes.",
    });

    const result = await searchMemoryV2Source(
      "alice notes",
      makeContext(root),
      5,
    );

    const hit = result.evidence.find(
      (e) => e.metadata?.retrieval === "activation",
    );
    expect(hit).toBeDefined();
    expect(hit?.locator).toBe("memory/concepts/people/alice.md");
    expect(hit?.metadata?.path).toBe("memory/concepts/people/alice.md");
    expect(hit?.metadata?.slug).toBe("people/alice");
    expect(hit?.title).toBe("people/alice");
  });

  test("lexical fallback surfaces nested concept pages with nested locators", async () => {
    const root = makeTempDir();
    writeConceptPage(
      root,
      "people/bob",
      "# Bob\n\nbirthday party plans for next month.\n",
    );

    qdrantHits = [];

    const result = await searchMemoryV2Source(
      "birthday party",
      makeContext(root),
      5,
    );

    const lexicalHit = result.evidence.find(
      (e) => e.metadata?.retrieval === "lexical",
    );
    expect(lexicalHit).toBeDefined();
    expect(lexicalHit?.metadata?.path).toBe("memory/concepts/people/bob.md");
    expect(lexicalHit?.locator).toMatch(
      /^memory\/concepts\/people\/bob\.md:\d+$/,
    );
  });

  test("returns empty when limit is zero", async () => {
    const root = makeTempDir();
    writeConceptPage(root, "alice", "Alice content");
    qdrantHits = [{ slug: "alice", denseScore: 0.9 }];

    const result = await searchMemoryV2Source("alice", makeContext(root), 0);

    expect(result.evidence).toEqual([]);
    expect(qdrantCalls).toHaveLength(0);
  });
});
