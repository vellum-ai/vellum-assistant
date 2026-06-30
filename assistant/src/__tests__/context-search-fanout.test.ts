import { describe, expect, test } from "bun:test";

import type { AssistantConfig } from "../config/schema.js";
import { formatDeterministicRecallAnswer } from "../plugins/defaults/memory/context-search/format.js";
import { runDeterministicRecallSearch } from "../plugins/defaults/memory/context-search/search.js";
import type {
  RecallEvidence,
  RecallSearchContext,
  RecallSource,
  RecallSourceAdapter,
} from "../plugins/defaults/memory/context-search/types.js";

function makeContext(): RecallSearchContext {
  return {
    workingDir: "/workspace",
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
  test("runs only selected source adapters", async () => {
    const calls: RecallSource[] = [];
    const result = await runDeterministicRecallSearch(
      {
        query: "launch notes",
        sources: ["memory", "workspace"],
        max_results: 5,
      },
      makeContext(),
      {
        adapters: [
          makeAdapter(
            "memory",
            [makeEvidence("memory", { id: "memory:search" })],
            calls,
          ),
          makeAdapter("conversations", [makeEvidence("conversations")], calls),
          makeAdapter("workspace", [makeEvidence("workspace")], calls),
        ],
      },
    );

    expect(calls).toEqual(["memory", "workspace"]);
    expect(result.searchedSources.map((note) => note.source)).toEqual([
      "memory",
      "workspace",
    ]);
    expect(result.evidence.map((item) => item.id)).toEqual([
      "memory:search",
      "workspace:evidence",
    ]);
  });

  test("searches every source by default", async () => {
    const calls: RecallSource[] = [];
    await runDeterministicRecallSearch({ query: "deployment" }, makeContext(), {
      adapters: [
        makeAdapter("memory", [], calls),
        makeAdapter("conversations", [], calls),
        makeAdapter("workspace", [], calls),
      ],
    });

    expect(calls).toEqual(["memory", "conversations", "workspace"]);
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
        sources: ["workspace", "memory", "conversations"],
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
          makeAdapter("conversations", [
            makeEvidence("conversations", {
              id: "conversations:newer-same-score",
              score: 0.7,
              timestampMs: 200,
            }),
            makeEvidence("conversations", {
              id: "conversations:source-priority",
              score: 0.4,
              timestampMs: 100,
            }),
          ]),
        ],
      },
    );

    expect(result.evidence.map((item) => item.id)).toEqual([
      "workspace:older-high",
      "conversations:newer-same-score",
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
