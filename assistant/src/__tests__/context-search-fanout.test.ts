import { describe, expect, test } from "bun:test";

import type { AssistantConfig } from "../config/schema.js";
import { formatDeterministicRecallAnswer } from "../memory/context-search/format.js";
import { runDeterministicRecallSearch } from "../memory/context-search/search.js";
import type {
  RecallEvidence,
  RecallSearchContext,
  RecallSource,
  RecallSourceAdapter,
} from "../memory/context-search/types.js";

function makeContext(): RecallSearchContext {
  return {
    workingDir: "/workspace",
    memoryScopeId: "scope-123",
    conversationId: "conv-xyz",
    config: {} as AssistantConfig,
  };
}

function makeEvidence(
  source: RecallSource,
  overrides: Partial<RecallEvidence> = {},
): RecallEvidence {
  return {
    id: `${source}:evidence`,
    source,
    title: `${source} title`,
    locator: `${source}:locator`,
    excerpt: `${source} excerpt`,
    ...overrides,
  };
}

function makeAdapter(
  source: RecallSource,
  evidence: RecallEvidence[],
  calls: RecallSource[] = [],
): RecallSourceAdapter {
  return {
    source,
    async search() {
      calls.push(source);
      return { evidence };
    },
  };
}

describe("runDeterministicRecallSearch", () => {
  test("runs only selected source adapters and includes PKB context evidence", async () => {
    const calls: RecallSource[] = [];
    const result = await runDeterministicRecallSearch(
      { query: "launch notes", sources: ["pkb", "workspace"], max_results: 5 },
      makeContext(),
      {
        adapters: [
          makeAdapter("memory", [makeEvidence("memory")], calls),
          makeAdapter(
            "pkb",
            [makeEvidence("pkb", { id: "pkb:search" })],
            calls,
          ),
          makeAdapter("workspace", [makeEvidence("workspace")], calls),
        ],
        readPkbContextEvidence: () => [
          makeEvidence("pkb", {
            id: "pkb:auto-inject",
            title: "PKB auto-injected context",
            locator: "pkb:auto-inject",
            excerpt: "Pinned launch plan from context.",
          }),
          makeEvidence("pkb", {
            id: "pkb:NOW.md",
            title: "NOW.md",
            locator: "NOW.md",
            excerpt: "Current launch focus.",
          }),
        ],
      },
    );

    expect(calls).toEqual(["pkb", "workspace"]);
    expect(result.searchedSources.map((note) => note.source)).toEqual([
      "pkb",
      "workspace",
    ]);
    expect(result.evidence.map((item) => item.id)).toEqual([
      "pkb:NOW.md",
      "pkb:auto-inject",
      "pkb:search",
      "workspace:evidence",
    ]);
  });

  test("searches every source by default", async () => {
    const calls: RecallSource[] = [];
    await runDeterministicRecallSearch({ query: "deployment" }, makeContext(), {
      adapters: [
        makeAdapter("memory", [], calls),
        makeAdapter("pkb", [], calls),
        makeAdapter("conversations", [], calls),
        makeAdapter("workspace", [], calls),
      ],
      readPkbContextEvidence: () => [],
    });

    expect(calls).toEqual(["memory", "pkb", "conversations", "workspace"]);
  });

  test("isolates adapter failures and reports degraded source notes", async () => {
    const result = await runDeterministicRecallSearch(
      { query: "status", sources: ["memory", "workspace"] },
      makeContext(),
      {
        adapters: [
          {
            source: "memory",
            async search() {
              throw new Error("memory unavailable");
            },
          },
          makeAdapter("workspace", [
            makeEvidence("workspace", { excerpt: "Workspace status note." }),
          ]),
        ],
      },
    );

    expect(result.evidence.map((item) => item.source)).toEqual(["workspace"]);
    expect(result.searchedSources).toEqual([
      {
        source: "memory",
        status: "degraded",
        evidenceCount: 0,
        error: "memory unavailable",
      },
      { source: "workspace", status: "searched", evidenceCount: 1 },
    ]);

    const answer = formatDeterministicRecallAnswer(result).answer;
    expect(answer).toContain("Found evidence:");
    expect(answer).toContain("Degraded sources: memory (memory unavailable).");
  });

  test("de-duplicates evidence by source, locator, and normalized excerpt", async () => {
    const result = await runDeterministicRecallSearch(
      { query: "same", sources: ["workspace"], max_results: 5 },
      makeContext(),
      {
        adapters: [
          makeAdapter("workspace", [
            makeEvidence("workspace", {
              id: "workspace:best",
              locator: "notes.md:1",
              excerpt: "Repeated fact",
              score: 0.9,
            }),
            makeEvidence("workspace", {
              id: "workspace:duplicate",
              locator: "notes.md:1",
              excerpt: " repeated   FACT ",
              score: 0.2,
            }),
            makeEvidence("workspace", {
              id: "workspace:distinct",
              locator: "notes.md:2",
              excerpt: "Repeated fact",
              score: 0.1,
            }),
          ]),
        ],
      },
    );

    expect(result.evidence.map((item) => item.id)).toEqual([
      "workspace:best",
      "workspace:distinct",
    ]);
  });

  test("sorts by score, recency, and source priority before enforcing total cap", async () => {
    const result = await runDeterministicRecallSearch(
      {
        query: "priority",
        sources: ["workspace", "memory", "pkb"],
        max_results: 3,
      },
      makeContext(),
      {
        adapters: [
          makeAdapter("workspace", [
            makeEvidence("workspace", {
              id: "workspace:older-high",
              score: 0.8,
              timestampMs: 100,
            }),
          ]),
          makeAdapter("memory", [
            makeEvidence("memory", {
              id: "memory:older-low",
              score: 0.4,
              timestampMs: 100,
            }),
            makeEvidence("memory", {
              id: "memory:same-score",
              score: 0.7,
              timestampMs: 50,
            }),
          ]),
          makeAdapter("pkb", [
            makeEvidence("pkb", {
              id: "pkb:newer-same-score",
              score: 0.7,
              timestampMs: 200,
            }),
            makeEvidence("pkb", {
              id: "pkb:source-priority",
              score: 0.4,
              timestampMs: 100,
            }),
          ]),
        ],
        readPkbContextEvidence: () => [],
      },
    );

    expect(result.evidence.map((item) => item.id)).toEqual([
      "workspace:older-high",
      "pkb:newer-same-score",
      "memory:same-score",
    ]);
  });

  test("formats no-result responses with searched and degraded sources", async () => {
    const result = await runDeterministicRecallSearch(
      { query: "nothing", sources: ["memory", "workspace"] },
      makeContext(),
      {
        adapters: [
          makeAdapter("memory", []),
          {
            source: "workspace",
            async search() {
              throw new Error("workspace timed out");
            },
          },
        ],
      },
    );

    expect(formatDeterministicRecallAnswer(result)).toEqual({
      answer:
        "No reliable results found.\nSearched sources: memory, workspace.\nDegraded sources: workspace (workspace timed out).",
      evidence: [],
    });
  });
});
