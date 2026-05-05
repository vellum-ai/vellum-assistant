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
import type { Provider, ProviderResponse } from "../providers/types.js";

let configuredProvider: Provider | null = null;
const getConfiguredProviderCallSites: string[] = [];

mock.module("../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async (callSite: string) => {
    getConfiguredProviderCallSites.push(callSite);
    return configuredProvider;
  },
}));

import { runAgenticRecall } from "../memory/context-search/agent-runner.js";
import type {
  RecallEvidence,
  RecallSearchContext,
  RecallSource,
  RecallSourceAdapter,
} from "../memory/context-search/types.js";

interface SearchCall {
  source: RecallSource;
  query: string;
  limit: number;
  signal?: AbortSignal;
}

const testDirs: string[] = [];

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "context-search-agent-runner-")),
  );
  testDirs.push(dir);
  return dir;
}

function writeWorkspaceFile(root: string, relativePath: string, text: string) {
  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, text);
}

function makeContext(
  signal?: AbortSignal,
  workingDir = "/workspace",
): RecallSearchContext {
  return {
    workingDir,
    conversationId: "conv-xyz",
    config: {} as AssistantConfig,
    ...(signal ? { signal } : {}),
  };
}

function makeEvidence(
  id: string,
  overrides: Partial<RecallEvidence> = {},
): RecallEvidence {
  return {
    id,
    source: "workspace",
    title: `${id} title`,
    locator: `${id}.md`,
    excerpt: `${id} excerpt`,
    score: 0.9,
    ...overrides,
  };
}

function makeAdapter(
  evidenceByQuery: Record<string, RecallEvidence[]>,
  calls: SearchCall[] = [],
  source: RecallSource = "workspace",
): RecallSourceAdapter {
  return {
    source,
    async search(query, context, limit) {
      calls.push({ source, query, limit, signal: context.signal });
      return { evidence: evidenceByQuery[query] ?? [] };
    },
  };
}

function makeProvider(
  responses: Array<ProviderResponse | Error>,
  calls: unknown[][] = [],
): Provider {
  return {
    name: "mock-provider",
    async sendMessage(...args) {
      calls.push(args);
      const next = responses.shift();
      if (!next) {
        throw new Error("unexpected provider call");
      }
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
  };
}

function toolResponse(
  name: string,
  input: Record<string, unknown>,
): ProviderResponse {
  return {
    content: [{ type: "tool_use", id: `${name}-1`, name, input }],
    model: "mock-model",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "tool_use",
  };
}

function textResponse(text: string): ProviderResponse {
  return {
    content: [{ type: "text", text }],
    model: "mock-model",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "end_turn",
  };
}

describe("runAgenticRecall", () => {
  beforeEach(() => {
    configuredProvider = null;
    getConfiguredProviderCallSites.length = 0;
  });

  test("falls back to deterministic recall when no provider is configured", async () => {
    const searchCalls: SearchCall[] = [];
    const result = await runAgenticRecall(
      { query: "launch notes", sources: ["workspace"], max_results: 3 },
      makeContext(),
      {
        searchOptions: {
          adapters: [
            makeAdapter(
              { "launch notes": [makeEvidence("workspace:launch")] },
              searchCalls,
            ),
          ],
        },
      },
    );

    expect(getConfiguredProviderCallSites).toEqual(["recall"]);
    expect(searchCalls.map((call) => call.query)).toEqual(["launch notes"]);
    expect(result.debug).toMatchObject({
      mode: "deterministic_fallback",
      fallbackReason: "no_provider",
      roundsUsed: 0,
    });
    expect(result.content).toContain("Found evidence:");
    expect(result.evidence.map((item) => item.id)).toEqual([
      "workspace:launch",
    ]);
  });

  test("returns a valid finish_recall answer with cited evidence", async () => {
    configuredProvider = makeProvider([
      toolResponse("finish_recall", {
        answer: "Alice chose Friday.",
        confidence: "high",
        citation_ids: ["workspace:launch"],
      }),
    ]);

    const result = await runAgenticRecall(
      { query: "launch notes", sources: ["workspace"] },
      makeContext(),
      {
        searchOptions: {
          adapters: [
            makeAdapter({
              "launch notes": [makeEvidence("workspace:launch")],
            }),
          ],
        },
      },
    );

    expect(result.content).toBe(
      "Alice chose Friday.\n\nSearched sources: workspace.",
    );
    expect(result.debug.mode).toBe("agentic");
    expect(result.debug.roundsUsed).toBe(1);
    expect(result.debug.finish).toEqual({
      confidence: "high",
      citationIds: ["workspace:launch"],
    });
    expect(result.evidence.map((item) => item.id)).toEqual([
      "workspace:launch",
    ]);
  });

  test("rejects negative synthesized answers when relevant evidence exists", async () => {
    configuredProvider = makeProvider([
      toolResponse("finish_recall", {
        answer:
          "The available evidence does not contain information about where Alice lives.",
        confidence: "low",
        citation_ids: [],
      }),
    ]);
    const searchCalls: SearchCall[] = [];

    const result = await runAgenticRecall(
      { query: "Where does Alice live?", sources: ["pkb"], max_results: 5 },
      makeContext(),
      {
        searchOptions: {
          adapters: [
            makeAdapter(
              {
                "alice lives residence": [
                  makeEvidence("pkb:alice-home", {
                    source: "pkb",
                    title: "people/alice.md",
                    locator: "people/alice.md:6",
                    excerpt:
                      "6: Lives at Bob's parents' house in Katy and has her own room there.",
                    metadata: {
                      retrieval: "lexical",
                      path: "people/alice.md",
                    },
                  }),
                ],
              },
              searchCalls,
              "pkb",
            ),
          ],
          readPkbContextEvidence: () => [],
        },
      },
    );

    expect(searchCalls.map((call) => call.query)).toEqual([
      "Where does Alice live?",
      "alice home address location",
      "alice lives residence",
    ]);
    expect(result.debug).toMatchObject({
      mode: "deterministic_fallback",
      fallbackReason: "finish_answer_validation_failed",
      fallbackDetail: "negative_or_incomplete_finish_with_relevant_evidence",
    });
    expect(result.content).toContain("Found evidence:");
    expect(result.content).toContain("Lives at Bob's parents' house in Katy");
    expect(result.content).toContain("Searched sources: pkb.");
  });

  test("seeds lead-in questions with declarative chain searches", async () => {
    const searchCalls: SearchCall[] = [];
    configuredProvider = makeProvider([
      toolResponse("finish_recall", {
        answer:
          "Bob's April 24 letter followed the proud moment, the 1-in-99 hypothetical, and the direct evening disclosure.",
        confidence: "high",
        citation_ids: ["pkb:bob-letter-chain"],
      }),
    ]);

    const result = await runAgenticRecall(
      {
        query: "What led to Bob's April 24 letter?",
        sources: ["pkb"],
        max_results: 5,
      },
      makeContext(),
      {
        searchOptions: {
          adapters: [
            makeAdapter(
              {
                "bob april 24 letter": [
                  makeEvidence("pkb:bob-letter-chain", {
                    source: "pkb",
                    title: "archive/2026-04-24.md",
                    locator: "archive/2026-04-24.md:42",
                    excerpt:
                      "42: The day moved from the PROUD beat to the 1/99 hypothetical, then into Bob's letter and the direct disclosure.",
                    metadata: {
                      retrieval: "lexical",
                      path: "archive/2026-04-24.md",
                    },
                  }),
                ],
              },
              searchCalls,
              "pkb",
            ),
          ],
          readPkbContextEvidence: () => [],
        },
      },
    );

    expect(searchCalls.map((call) => call.query)).toEqual([
      "What led to Bob's April 24 letter?",
      "led bob april 24 letter",
      "bob april 24 letter",
      "bob april 24 letter context reason before chain",
    ]);
    expect(result.content).toContain("1-in-99 hypothetical");
    expect(result.content).toContain("Searched sources: pkb.");
  });

  test("executes follow-up search_sources through narrowed local searches", async () => {
    const providerCalls: unknown[][] = [];
    configuredProvider = makeProvider(
      [
        toolResponse("search_sources", {
          query: "decision notes",
          sources: ["workspace", "memory"],
          limit: 2,
          reason: "Need the explicit decision.",
        }),
        toolResponse("finish_recall", {
          answer: "The decision note says Friday.",
          confidence: "medium",
          citation_ids: ["workspace:decision"],
        }),
      ],
      providerCalls,
    );
    const controller = new AbortController();
    const searchCalls: SearchCall[] = [];

    const result = await runAgenticRecall(
      {
        query: "launch notes",
        sources: ["workspace"],
        max_results: 3,
        depth: "standard",
      },
      makeContext(controller.signal),
      {
        searchOptions: {
          adapters: [
            makeAdapter(
              {
                "launch notes": [makeEvidence("workspace:seed")],
                "decision notes": [makeEvidence("workspace:decision")],
              },
              searchCalls,
            ),
          ],
        },
      },
    );

    expect(providerCalls).toHaveLength(2);
    expect(searchCalls).toEqual([
      {
        source: "workspace",
        query: "launch notes",
        limit: 6,
        signal: controller.signal,
      },
      {
        source: "workspace",
        query: "decision notes",
        limit: 2,
        signal: controller.signal,
      },
    ]);
    expect(result.content).toBe(
      "The decision note says Friday.\n\nSearched sources: workspace.",
    );
    expect(result.debug.searchCalls).toEqual([
      {
        round: 1,
        query: "decision notes",
        sources: ["workspace"],
        limit: 2,
        reason: "Need the explicit decision.",
        evidenceCount: 1,
      },
    ]);
  });

  test("executes inspect_workspace_paths for surfaced workspace paths", async () => {
    const root = makeTempDir();
    writeWorkspaceFile(
      root,
      "scratch/handoff.md",
      ["# Handoff", "Use the crimson folder for the next review."].join("\n"),
    );
    const providerCalls: unknown[][] = [];
    configuredProvider = makeProvider(
      [
        toolResponse("inspect_workspace_paths", {
          paths: ["scratch/handoff.md"],
          reason: "Need the exact handoff file.",
        }),
        toolResponse("finish_recall", {
          answer: "The handoff says to use the crimson folder.",
          confidence: "high",
          citation_ids: ["workspace:scratch/handoff.md:1:path"],
        }),
      ],
      providerCalls,
    );

    const result = await runAgenticRecall(
      { query: "handoff", sources: ["workspace"], max_results: 5 },
      makeContext(undefined, root),
      {
        searchOptions: {
          adapters: [
            makeAdapter({
              handoff: [
                makeEvidence("workspace:pointer", {
                  excerpt: "The current handoff file is scratch/handoff.md.",
                }),
              ],
            }),
          ],
        },
      },
    );

    expect(providerCalls).toHaveLength(2);
    expect(result.content).toContain("crimson folder");
    expect(result.debug.inspectCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          round: 1,
          paths: ["scratch/handoff.md"],
          evidenceCount: 1,
        }),
      ]),
    );
    expect(result.evidence).toEqual([
      expect.objectContaining({
        id: "workspace:scratch/handoff.md:1:path",
        title: "scratch/handoff.md",
      }),
    ]);
  });

  test("auto-inspects exact workspace paths before deterministic fallback", async () => {
    const root = makeTempDir();
    writeWorkspaceFile(root, "scratch/handoff.md", "handoff exact truth");

    const result = await runAgenticRecall(
      { query: "handoff", sources: ["workspace"], max_results: 5 },
      makeContext(undefined, root),
      {
        searchOptions: {
          adapters: [
            makeAdapter({
              handoff: [
                makeEvidence("workspace:pointer", {
                  excerpt: "The exact note is at scratch/handoff.md.",
                }),
              ],
            }),
          ],
        },
      },
    );

    expect(result.debug).toMatchObject({
      mode: "deterministic_fallback",
      fallbackReason: "no_provider",
      inspectCalls: [
        {
          round: 0,
          paths: ["scratch/handoff.md"],
          evidenceCount: 1,
        },
      ],
    });
    expect(result.evidence.map((item) => item.id)).toEqual([
      "workspace:pointer",
      "workspace:scratch/handoff.md:1:path",
    ]);
  });

  test("auto-inspects PKB-relative paths as workspace paths", async () => {
    const root = makeTempDir();
    writeWorkspaceFile(
      root,
      "pkb/archive/2026-04-24.md",
      "The archive has the exact letter chain.",
    );

    const result = await runAgenticRecall(
      {
        query: "letter chain",
        sources: ["pkb"],
        max_results: 5,
      },
      makeContext(undefined, root),
      {
        searchOptions: {
          adapters: [
            makeAdapter(
              {
                "letter chain": [
                  makeEvidence("pkb:pointer", {
                    source: "pkb",
                    title: "archive/2026-04-24.md",
                    locator: "archive/2026-04-24.md:42",
                    excerpt: "The exact note is archive/2026-04-24.md.",
                    metadata: {
                      retrieval: "lexical",
                      path: "archive/2026-04-24.md",
                    },
                  }),
                ],
              },
              [],
              "pkb",
            ),
          ],
          readPkbContextEvidence: () => [],
        },
      },
    );

    expect(result.debug.inspectCalls).toEqual([
      {
        round: 0,
        paths: ["pkb/archive/2026-04-24.md"],
        reason:
          "Automatically inspect exact workspace paths surfaced by seed evidence.",
        evidenceCount: 1,
      },
    ]);
    expect(result.content).toContain(
      "Inspected workspace paths: pkb/archive/2026-04-24.md.",
    );
    expect(result.evidence.map((item) => item.id)).toEqual([
      "pkb:pointer",
      "workspace:pkb/archive/2026-04-24.md:1:path",
    ]);
  });

  test("rejects unsafe inspect_workspace_paths requests as unresolved evidence", async () => {
    configuredProvider = makeProvider([
      toolResponse("inspect_workspace_paths", {
        paths: ["../secret.md"],
        reason: "Try an unsafe path.",
      }),
      toolResponse("finish_recall", {
        answer: "The requested file could not be inspected safely.",
        confidence: "low",
        citation_ids: ["workspace:inspect-error:1:0"],
        unresolved: ["The path was not surfaced as a safe workspace file."],
      }),
    ]);

    const result = await runAgenticRecall(
      { query: "unsafe handoff", sources: ["workspace"], max_results: 5 },
      makeContext(),
      {
        searchOptions: {
          adapters: [
            makeAdapter({
              "unsafe handoff": [makeEvidence("workspace:seed")],
            }),
          ],
        },
      },
    );

    expect(result.content).toContain("could not be inspected safely");
    expect(result.debug.inspectCalls).toEqual([
      {
        round: 1,
        paths: ["../secret.md"],
        reason: "Try an unsafe path.",
        evidenceCount: 1,
        errors: [
          {
            path: "../secret.md",
            reason:
              "path was not a safe relative workspace file surfaced by the query or prior evidence",
          },
        ],
      },
    ]);
    expect(result.evidence).toEqual([
      expect.objectContaining({
        id: "workspace:inspect-error:1:0",
        locator: "../secret.md",
      }),
    ]);
  });

  test("seeds indirect referent queries with broad object searches", async () => {
    const searchCalls: SearchCall[] = [];
    configuredProvider = makeProvider([
      toolResponse("finish_recall", {
        answer:
          "Bob's question points to Alice's office birthday cake, with a caveat that the exact referent was initially unresolved.",
        confidence: "medium",
        citation_ids: ["workspace:referent", "workspace:cake"],
        unresolved: ["Bob did not explicitly restate which cake he meant."],
      }),
    ]);

    const result = await runAgenticRecall(
      {
        query: "the cake Bob asked about",
        sources: ["workspace"],
        max_results: 5,
      },
      makeContext(),
      {
        searchOptions: {
          adapters: [
            makeAdapter(
              {
                "the cake Bob asked about": [
                  makeEvidence("workspace:referent", {
                    excerpt:
                      "Bob asked whether the shirt and the cake were Alice's way of sending something into the room.",
                  }),
                ],
                cake: [
                  makeEvidence("workspace:cake", {
                    excerpt:
                      "The office birthday cake had raspberry filling and a message from Alice.",
                  }),
                ],
              },
              searchCalls,
            ),
          ],
        },
      },
    );

    expect(searchCalls.map((call) => call.query)).toEqual([
      "the cake Bob asked about",
      "cake",
      "cake bob",
      "cake paid delivery design inscription flavor message",
    ]);
    expect(result.content).toContain("Alice's office birthday cake");
    expect(result.evidence.map((item) => item.id)).toEqual([
      "workspace:referent",
      "workspace:cake",
    ]);
  });

  test("preserves direct recall for shirt evidence", async () => {
    configuredProvider = makeProvider([
      toolResponse("finish_recall", {
        answer:
          "The Property of Example Assistant shirt was black with a pink Cormorant wordmark, deployed on Apr 24 and revealed to Bob's parents.",
        confidence: "high",
        citation_ids: ["workspace:shirt", "workspace:shirt-context"],
      }),
    ]);

    const result = await runAgenticRecall(
      {
        query: "Property of Example Assistant shirt",
        sources: ["workspace"],
        max_results: 5,
      },
      makeContext(),
      {
        searchOptions: {
          adapters: [
            makeAdapter({
              "Property of Example Assistant shirt": [
                makeEvidence("workspace:shirt", {
                  excerpt:
                    "Property of Example Assistant shirt: black shirt with pink Cormorant wordmark.",
                }),
                makeEvidence("workspace:shirt-context", {
                  excerpt:
                    "The Apr 24 deployment included Bob and the parents reveal context.",
                }),
              ],
            }),
          ],
        },
      },
    );

    expect(result.content).toContain("black");
    expect(result.content).toContain("pink Cormorant wordmark");
    expect(result.evidence.map((item) => item.id)).toEqual([
      "workspace:shirt",
      "workspace:shirt-context",
    ]);
  });

  test("makes a final finish-only call when search exhausts the round budget", async () => {
    const providerCalls: unknown[][] = [];
    configuredProvider = makeProvider(
      [
        toolResponse("search_sources", {
          query: "more notes",
          sources: ["workspace"],
          reason: "Need more.",
        }),
        toolResponse("finish_recall", {
          answer: "The follow-up note resolves it.",
          confidence: "medium",
          citation_ids: ["workspace:more"],
          unresolved: ["The original seed only named the topic."],
        }),
      ],
      providerCalls,
    );

    const result = await runAgenticRecall(
      { query: "launch notes", sources: ["workspace"], depth: "fast" },
      makeContext(),
      {
        searchOptions: {
          adapters: [
            makeAdapter({
              "launch notes": [makeEvidence("workspace:seed")],
              "more notes": [makeEvidence("workspace:more")],
            }),
          ],
        },
      },
    );

    expect(providerCalls).toHaveLength(2);
    expect(result.debug.roundLimit).toBe(1);
    expect(result.debug.roundsUsed).toBe(1);
    expect(result.debug.mode).toBe("agentic");
    expect(result.debug.finish).toEqual({
      confidence: "medium",
      citationIds: ["workspace:more"],
      unresolved: ["The original seed only named the topic."],
    });
    const finalTools = providerCalls[1]?.[1] as Array<{ name: string }>;
    expect(finalTools.map((tool) => tool.name)).toEqual(["finish_recall"]);
    expect(result.evidence.map((item) => item.id)).toEqual(["workspace:more"]);
    expect(result.content).toBe(
      "The follow-up note resolves it.\n\nAvailable evidence:\n1. [workspace] workspace:more title (workspace:more.md): workspace:more excerpt\n2. [workspace] workspace:seed title (workspace:seed.md): workspace:seed excerpt\n\nSearched sources: workspace.",
    );
  });

  test("rejects finish citations omitted from the prompted evidence table", async () => {
    const providerCalls: unknown[][] = [];
    configuredProvider = makeProvider(
      [
        toolResponse("finish_recall", {
          answer: "Unsupported by prompted evidence.",
          confidence: "high",
          citation_ids: ["workspace:omitted"],
        }),
      ],
      providerCalls,
    );

    const longExcerpt = "a".repeat(6_000);
    const result = await runAgenticRecall(
      {
        query: "launch notes",
        sources: ["memory", "pkb", "workspace"],
        max_results: 3,
      },
      makeContext(),
      {
        searchOptions: {
          adapters: [
            makeAdapter(
              {
                "launch notes": [
                  makeEvidence("memory:included", {
                    source: "memory",
                    excerpt: longExcerpt,
                    score: 0.9,
                  }),
                ],
              },
              [],
              "memory",
            ),
            makeAdapter(
              {
                "launch notes": [
                  makeEvidence("pkb:included", {
                    source: "pkb",
                    excerpt: longExcerpt,
                    score: 0.8,
                  }),
                ],
              },
              [],
              "pkb",
            ),
            makeAdapter(
              {
                "launch notes": [
                  makeEvidence("workspace:omitted", {
                    source: "workspace",
                    excerpt: longExcerpt,
                    score: 0.7,
                  }),
                ],
              },
              [],
              "workspace",
            ),
          ],
          readPkbContextEvidence: () => [],
        },
      },
    );

    expect(providerCalls).toHaveLength(1);
    const messages = providerCalls[0]?.[0] as Array<{
      content: Array<{ type: string; text?: string }>;
    }>;
    const prompt = messages[0]?.content[0]?.text ?? "";
    expect(prompt).toContain(
      "Allowed citation_ids: memory:included, pkb:included",
    );
    expect(prompt).not.toContain("workspace:omitted");
    expect(result.debug).toMatchObject({
      mode: "deterministic_fallback",
      fallbackReason: "citation_validation_failed",
      fallbackDetail: "unknown_citation_ids",
    });
  });

  test("falls back when finish_recall cites unknown evidence", async () => {
    configuredProvider = makeProvider([
      toolResponse("finish_recall", {
        answer: "Unsupported answer.",
        confidence: "high",
        citation_ids: ["workspace:missing"],
      }),
    ]);

    const result = await runAgenticRecall(
      { query: "launch notes", sources: ["workspace"] },
      makeContext(),
      {
        searchOptions: {
          adapters: [
            makeAdapter({
              "launch notes": [makeEvidence("workspace:seed")],
            }),
          ],
        },
      },
    );

    expect(result.debug).toMatchObject({
      mode: "deterministic_fallback",
      fallbackReason: "citation_validation_failed",
      fallbackDetail: "unknown_citation_ids",
    });
    expect(result.content).toContain("Found evidence:");
  });

  test("falls back on provider errors", async () => {
    configuredProvider = makeProvider([new Error("provider unavailable")]);

    const result = await runAgenticRecall(
      { query: "launch notes", sources: ["workspace"] },
      makeContext(),
      {
        searchOptions: {
          adapters: [
            makeAdapter({
              "launch notes": [makeEvidence("workspace:seed")],
            }),
          ],
        },
      },
    );

    expect(result.debug).toMatchObject({
      mode: "deterministic_fallback",
      fallbackReason: "provider_error",
      fallbackDetail: "provider unavailable",
    });
  });

  test("keeps auto-injected context behind concrete evidence after agent searches", async () => {
    configuredProvider = makeProvider([
      toolResponse("search_sources", {
        query: "follow up",
        sources: ["workspace"],
        reason: "Need concrete follow-up evidence.",
      }),
      textResponse("not a finish"),
    ]);

    const result = await runAgenticRecall(
      {
        query: "launch notes",
        sources: ["pkb", "workspace"],
        max_results: 3,
      },
      makeContext(),
      {
        searchOptions: {
          adapters: [
            makeAdapter({}, [], "pkb"),
            makeAdapter(
              {
                "launch notes": [makeEvidence("workspace:seed")],
                "follow up": [makeEvidence("workspace:searched")],
              },
              [],
              "workspace",
            ),
          ],
          readPkbContextEvidence: () => [
            makeEvidence("pkb:auto-inject", {
              source: "pkb",
              title: "PKB auto-injected context",
              locator: "pkb:auto-inject",
              excerpt: "Always-present background context.",
            }),
            makeEvidence("pkb:NOW.md", {
              source: "pkb",
              title: "NOW.md",
              locator: "NOW.md",
              excerpt: "Always-present NOW context.",
            }),
          ],
        },
      },
    );

    expect(result.debug.mode).toBe("deterministic_fallback");
    expect(result.evidence.map((item) => item.id)).toEqual([
      "workspace:seed",
      "workspace:searched",
      "pkb:NOW.md",
      "pkb:auto-inject",
    ]);
  });

  test("routes provider calls through the recall call site with temperature zero and thinking disabled", async () => {
    // `thinking: disabled` is required because the call hardcodes
    // `temperature: 0`. Anthropic 400s on `temperature` ≠ 1 whenever
    // thinking is enabled or in adaptive mode, so user profiles that
    // resolve thinking-enabled (Opus 4.x at `effort: high|xhigh`, etc.)
    // would fail without an explicit opt-out. Recall is tool-call-heavy
    // reasoning where determinism (temp=0) matters more than extended
    // chain-of-thought.
    const providerCalls: unknown[][] = [];
    configuredProvider = makeProvider(
      [textResponse("not a tool call")],
      providerCalls,
    );

    await runAgenticRecall(
      { query: "launch notes", sources: ["workspace"] },
      makeContext(),
      {
        searchOptions: {
          adapters: [
            makeAdapter({
              "launch notes": [makeEvidence("workspace:seed")],
            }),
          ],
        },
      },
    );

    expect(getConfiguredProviderCallSites).toEqual(["recall"]);
    expect(providerCalls).toHaveLength(1);
    const options = providerCalls[0]?.[3] as {
      config?: Record<string, unknown>;
    };
    expect(options.config).toEqual({
      callSite: "recall",
      temperature: 0,
      thinking: { type: "disabled" },
    });
  });

  test("final finish-only call also disables thinking", async () => {
    // Regression guard for the second `temperature: 0` call site in
    // `tryFinalFinishRecall`. Both recall provider calls (the agent loop
    // round and the fallback finalize) must opt out of thinking; otherwise
    // user profiles that resolve thinking-enabled trigger the Anthropic
    // 400 on `temperature` ≠ 1.
    const providerCalls: unknown[][] = [];
    configuredProvider = makeProvider(
      [
        // First call: agent loop round — emits a search_sources tool use
        // so the loop continues until the round budget is exhausted.
        toolResponse("search_sources", {
          query: "more notes",
          sources: ["workspace"],
          reason: "Need more.",
        }),
        // Second call: fallback finalize — handler we want to assert on.
        toolResponse("finish_recall", {
          answer: "Resolved.",
          confidence: "medium",
          citation_ids: ["workspace:more"],
        }),
      ],
      providerCalls,
    );

    await runAgenticRecall(
      { query: "launch notes", sources: ["workspace"], depth: "fast" },
      makeContext(),
      {
        searchOptions: {
          adapters: [
            makeAdapter({
              "launch notes": [makeEvidence("workspace:seed")],
              "more notes": [makeEvidence("workspace:more")],
            }),
          ],
        },
      },
    );

    expect(providerCalls).toHaveLength(2);
    const finalizeOptions = providerCalls[1]?.[3] as {
      config?: Record<string, unknown>;
    };
    expect(finalizeOptions.config).toEqual({
      callSite: "recall",
      temperature: 0,
      thinking: { type: "disabled" },
    });
  });
});
