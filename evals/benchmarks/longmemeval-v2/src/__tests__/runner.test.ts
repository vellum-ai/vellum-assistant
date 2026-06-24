/**
 * Tests for the LongMemEval-V2 per-unit runner.
 *
 * Strategy: same `mock.module("../../../src/lib/runner/create-agent", …)`
 * test seam as `run-ingest-ask.test.ts`, plus a FakeAgent harness that
 * records workspace writes and exposes them for assertion. Judge calls
 * pick deterministic eval_functions so no network is involved.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";

import type {
  AgentEvent,
  AgentHatchInput,
  AgentMessage,
  BaseAgent,
  WorkspaceFileWrite,
} from "../../../../src/lib/adapter";
import { runArtifacts } from "../../../../src/lib/metrics";
import type { EvalProgressEvent } from "../../../../src/lib/runner/progress";
import type { Profile } from "../../../../src/lib/profile";
import type { TestSetupCommand } from "../../../../src/lib/setup-command";

import type { BenchmarkItem } from "../loader";
import {
  createInMemoryTrajectoryReader,
  type TrajectoryReader,
} from "../trajectory-reader";

let nextAgent: BaseAgent | null = null;
// Specifier is relative to THIS test file's location
// (`benchmarks/longmemeval-v2/src/__tests__/runner.test.ts`); the target
// resolves to the same absolute path as `./create-agent` from
// `src/lib/runner/run-ingest-ask.ts`, which is where the runner actually
// reaches `createAgent`.
mock.module("../../../../src/lib/runner/create-agent", () => ({
  createAgent: (input: AgentHatchInput): BaseAgent => {
    if (!nextAgent) {
      throw new Error(
        `test forgot to set nextAgent before runner reached createAgent (runId=${input.runId})`,
      );
    }
    return nextAgent;
  },
}));

import { runLongMemEvalV2Unit } from "../runner";

function profileFor(id: string): Profile {
  return {
    id,
    manifest: { species: "vellum" },
    workspaceDir: `/tmp/${id}/workspace`,
  };
}

function textEvent(text: string): AgentEvent {
  return { message: { type: "assistant_text_delta", text } };
}

/**
 * Usage-bearing AgentEvent that `summarizeAssistantUsage` will pick up.
 * Mirrors what a real adapter would emit on a turn boundary: a
 * `type: "usage"` envelope carrying the provider, model, and token
 * fields the pricing module reads.
 */
function usageEvent(usage: Record<string, unknown>): AgentEvent {
  return { message: { type: "usage", usage } };
}

interface FakeAgentHarness {
  agent: BaseAgent;
  writes: () => WorkspaceFileWrite[];
  sends: () => string[];
}

/**
 * Build the agent stub. `usageRecords` models what the egress jail's
 * recording sidecar observed on the wire (the assistant's real model
 * traffic) — the runner reads these via `readUsageRecords()` to price the
 * run, NOT the usage carried on emitted events. Omit to leave the agent
 * without the capability (the runner then prices only the judge's usage).
 */
function makeFakeAgent(
  responses: AgentEvent[][],
  usageRecords?: Array<Record<string, unknown>>,
): FakeAgentHarness {
  const writes: WorkspaceFileWrite[] = [];
  const sends: string[] = [];
  const queues = responses.map((q) => q.slice());
  let turn = 0;
  let conversationKey = "convo-1";

  const eventsFn = (): AsyncIterable<AgentEvent> => {
    const queue = queues[turn];
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<AgentEvent>> {
            if (!queue || queue.length === 0) {
              return { value: undefined, done: true };
            }
            const value = queue.shift()!;
            return { value, done: false };
          },
        };
      },
    };
  };

  const agent: BaseAgent = {
    id: "fake-agent",
    get conversationKey() {
      return conversationKey;
    },
    async hatch(): Promise<void> {},
    async send(message: AgentMessage): Promise<void> {
      sends.push(message.content);
    },
    async shutdown(): Promise<void> {},
    events: eventsFn,
    async writeWorkspaceFile(input: WorkspaceFileWrite): Promise<void> {
      writes.push(input);
    },
    async newConversation(): Promise<void> {
      turn += 1;
      conversationKey = `convo-${turn + 1}`;
    },
    // Not exercised by these tests (no per-test setup commands in V2's
    // ingest→ask flow), but BaseAgent declares it as required so we
    // satisfy the interface.
    async runSetupCommand(_command: TestSetupCommand): Promise<void> {},
    // Likewise unexercised: the ingest→ask flow uses quiet/sentinel
    // windows rather than the turn-completion signal.
    isTurnComplete(): boolean {
      return false;
    },
  };

  if (usageRecords) {
    agent.readUsageRecords = async () =>
      usageRecords.map((record) => ({ ...record }));
  }

  return {
    agent,
    writes: () => writes,
    sends: () => sends,
  };
}

function makeItem(overrides: Partial<BenchmarkItem> = {}): BenchmarkItem {
  return {
    questionId: "q_runner_1",
    ability: "static-state-recall",
    question: "What color was the laptop in the screenshot?",
    answer: "blue",
    evalFunction: "norm_phrase_set_match",
    trajectoryIds: ["t1", "t2"],
    ...overrides,
  };
}

function trajectoryReader(): TrajectoryReader {
  return createInMemoryTrajectoryReader([
    { id: "t1", domain: "web", states: [{ a: 1 }] },
    { id: "t2", domain: "web", states: [{ a: 2 }] },
  ]);
}

describe("runLongMemEvalV2Unit", () => {
  // Per-test cleanup: blow away the test's run dir so .runs/ doesn't
  // accumulate noise. We only touch dirs we know we created.
  const runIdsToCleanup: string[] = [];
  afterEach(async () => {
    nextAgent = null;
    while (runIdsToCleanup.length > 0) {
      const id = runIdsToCleanup.pop()!;
      await rm(runArtifacts(id).runDir, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
  });

  test("happy path: stages trajectories + manifest, grades, writes artifacts", async () => {
    const runId = `lme-v2-runner-happy-${Date.now()}`;
    runIdsToCleanup.push(runId);

    const harness = makeFakeAgent([
      [textEvent("Ready.")],
      // Hypothesis text — picked to match the answer "blue" under
      // norm_phrase_set_match (case-insensitive phrase-set match).
      [textEvent("The laptop was blue.")],
    ]);
    nextAgent = harness.agent;

    const events: EvalProgressEvent[] = [];
    const result = await runLongMemEvalV2Unit({
      profile: profileFor("p1"),
      item: makeItem(),
      trajectoryReader: trajectoryReader(),
      runId,
      progress: (e) => events.push(e),
      quietMs: 50,
    });

    // Result shape mirrors EvalRunResult
    expect(result.runId).toBe(runId);
    expect(result.profileId).toBe("p1");
    expect(result.testId).toBe("q_runner_1");
    expect(result.metrics).toHaveLength(1);
    expect(result.metrics[0]!.name).toBe("longmemeval-v2-judge");
    expect(result.metrics[0]!.score).toBe(1);
    expect(
      (result.metrics[0]!.metadata as Record<string, unknown>)["function"],
    ).toBe("norm_phrase_set_match");

    // Agent received exactly the materialized writes — trajectories
    // in haystack order plus the manifest
    const writePaths = harness.writes().map((w) => w.path);
    expect(writePaths).toEqual([
      "longmemeval/trajectories/t1.json",
      "longmemeval/trajectories/t2.json",
      "longmemeval/manifest.json",
    ]);

    // run.json reflects the lifecycle: running → completed
    const meta = JSON.parse(
      await readFile(runArtifacts(runId).metadataPath, "utf8"),
    );
    expect(meta.status).toBe("completed");
    expect(meta.testId).toBe("q_runner_1");
    expect(typeof meta.completedAt).toBe("string");

    // metrics.json carries the single judge metric
    const metricsOnDisk = JSON.parse(
      await readFile(runArtifacts(runId).metricsPath, "utf8"),
    );
    expect(metricsOnDisk).toHaveLength(1);
    expect(metricsOnDisk[0].score).toBe(1);

    // transcript.json carries the four-turn shape: ingest simulator,
    // ingest assistant response ("Ready."), question simulator, question
    // assistant response. The transcript is written incrementally by
    // runIngestAsk, not constructed manually by the benchmark runner.
    const transcript = JSON.parse(
      await readFile(runArtifacts(runId).transcriptPath, "utf8"),
    );
    expect(transcript).toHaveLength(4);
    expect(transcript[0].role).toBe("simulator");
    expect(transcript[1].role).toBe("assistant");
    expect(transcript[2].role).toBe("simulator");
    expect(transcript[2].content).toBe(
      "What color was the laptop in the screenshot?",
    );
    expect(transcript[3].role).toBe("assistant");
    expect(transcript[3].content).toBe("The laptop was blue.");

    // Progress events: artifacts/setup/send/metrics/result
    const steps = events.map((e) => `${e.step}:${e.status}`);
    expect(steps).toContain("artifacts:done");
    expect(steps).toContain("setup:done");
    expect(steps).toContain("send:done");
    expect(steps).toContain("metrics:done");
    expect(steps).toContain("result:done");
  });

  test("happy path: writes ingest-turn events to ingest-assistant-events.json, question-turn events to assistant-events.json", async () => {
    // V2 contract: the agent's memory-formation work (ingest turn —
    // "Ready.") lands in the sibling artifact so the report can render
    // it separately from the question-turn answer. Both arrays must be
    // non-empty and disjoint.
    const runId = `lme-v2-runner-events-${Date.now()}`;
    runIdsToCleanup.push(runId);
    const harness = makeFakeAgent([
      [textEvent("Indexing haystack…"), textEvent("\nReady.")],
      [textEvent("The laptop was blue.")],
    ]);
    nextAgent = harness.agent;

    await runLongMemEvalV2Unit({
      profile: profileFor("p1"),
      item: makeItem(),
      trajectoryReader: trajectoryReader(),
      runId,
      progress: () => {},
      quietMs: 50,
    });

    const artifacts = runArtifacts(runId);
    const questionEvents = JSON.parse(
      await readFile(artifacts.assistantEventsPath, "utf8"),
    ) as AgentEvent[];
    const ingestEvents = JSON.parse(
      await readFile(artifacts.ingestAssistantEventsPath, "utf8"),
    ) as AgentEvent[];

    // Question-turn event made it to assistant-events.json
    expect(questionEvents.length).toBeGreaterThan(0);
    expect(
      questionEvents.some(
        (e) =>
          (e.message as { type?: string; text?: string }).type ===
            "assistant_text_delta" &&
          (e.message as { text?: string }).text === "The laptop was blue.",
      ),
    ).toBe(true);

    // Ingest-turn event made it to the new sibling artifact
    expect(ingestEvents.length).toBeGreaterThan(0);
    expect(
      ingestEvents.some(
        (e) =>
          (e.message as { type?: string; text?: string }).type ===
            "assistant_text_delta" &&
          (e.message as { text?: string }).text === "Indexing haystack…",
      ),
    ).toBe(true);

    // The two arrays don't leak — each is exclusive to its turn.
    expect(
      ingestEvents.some(
        (e) => (e.message as { text?: string }).text === "The laptop was blue.",
      ),
    ).toBe(false);
    expect(
      questionEvents.some(
        (e) => (e.message as { text?: string }).text === "Indexing haystack…",
      ),
    ).toBe(false);
  });

  test("scores 0 when hypothesis misses the answer", async () => {
    const runId = `lme-v2-runner-miss-${Date.now()}`;
    runIdsToCleanup.push(runId);
    const harness = makeFakeAgent([
      [textEvent("Ready.")],
      [textEvent("I'm not sure, maybe red.")],
    ]);
    nextAgent = harness.agent;

    const result = await runLongMemEvalV2Unit({
      profile: profileFor("p1"),
      item: makeItem(),
      trajectoryReader: trajectoryReader(),
      runId,
      quietMs: 50,
    });

    expect(result.metrics[0]!.score).toBe(0);
  });

  test("marks status=completed and scores 0 when the question turn produces no answer in time", async () => {
    // GIVEN an ingest turn that completes on the sentinel
    // AND a question turn that emits only non-text events (retrieval /
    // thinking) and never composes an answer before its time budget elapses
    const runId = `lme-v2-runner-noanswer-${Date.now()}`;
    runIdsToCleanup.push(runId);
    const harness = makeFakeAgent([
      [textEvent("Ready.")],
      [{ message: { type: "tool_use_start", toolName: "lookup" } }],
    ]);
    nextAgent = harness.agent;

    // WHEN the unit runs
    const result = await runLongMemEvalV2Unit({
      profile: profileFor("p1"),
      item: makeItem(),
      trajectoryReader: trajectoryReader(),
      runId,
      questionMaxMs: 200,
      quietMs: 50,
    });

    // THEN the run is a completed miss, not an errored/failed run: it scores
    // 0 and counts in the denominator, with a time-based reason and no judge
    // function attribution (the judge never ran).
    expect(result.metrics[0]!.score).toBe(0);
    expect(result.metrics[0]!.reason).toMatch(/within the question turn's/);
    expect(result.metrics[0]!.reason).toMatch(/time budget/);
    expect(
      (result.metrics[0]!.metadata as Record<string, unknown>)["function"],
    ).toBe("no-answer");

    const meta = JSON.parse(
      await readFile(runArtifacts(runId).metadataPath, "utf8"),
    );
    expect(meta.status).toBe("completed");
    expect(meta.error).toBeUndefined();
  });

  test("marks status=failed when the ingest turn produces no events", async () => {
    const runId = `lme-v2-runner-fail-${Date.now()}`;
    runIdsToCleanup.push(runId);
    // Empty queue for the ingest turn → runIngestAsk throws.
    const harness = makeFakeAgent([[], [textEvent("never reached")]]);
    nextAgent = harness.agent;

    await expect(
      runLongMemEvalV2Unit({
        profile: profileFor("p1"),
        item: makeItem(),
        trajectoryReader: trajectoryReader(),
        runId,
        quietMs: 50,
      }),
    ).rejects.toThrow(/Ingest turn produced no events/);

    const meta = JSON.parse(
      await readFile(runArtifacts(runId).metadataPath, "utf8"),
    );
    expect(meta.status).toBe("failed");
    expect(meta.error).toMatch(/Ingest turn produced no events/);
  });

  /**
   * Cost is sourced from the egress jail's observed model traffic
   * (`readUsageRecords()`), not from usage carried on assistant-emitted
   * events — an assistant or its adapter could under-report by choosing
   * what to emit, so the jail is the un-spoofable authority. These tests
   * lock down the behaviour:
   *
   *  - assistant usage comes from the jail's records, folded through the
   *    same `summarizeAssistantUsage` the simulator runner uses
   *  - LLM-judge usage (the harness's own grading call) is merged in
   *    alongside as a separate entry
   *  - deterministic judges contribute nothing to usage.json
   *  - a judge that returns no usage block leaves assistant-only totals in
   *    place (no fabricated zeros)
   *  - usage carried on emitted events is NOT priced
   */
  test("prices the egress jail's observed usage on a deterministic-judge run", async () => {
    const runId = `lme-v2-runner-usage-${Date.now()}`;
    runIdsToCleanup.push(runId);

    const harness = makeFakeAgent(
      [[textEvent("Ready.")], [textEvent("The laptop was blue.")]],
      [
        {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          input_tokens: 1000,
          output_tokens: 100,
        },
        {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          input_tokens: 500,
          output_tokens: 30,
        },
      ],
    );
    nextAgent = harness.agent;

    await runLongMemEvalV2Unit({
      profile: profileFor("p1"),
      item: makeItem(),
      trajectoryReader: trajectoryReader(),
      runId,
      quietMs: 50,
    });

    const usage = JSON.parse(
      await readFile(runArtifacts(runId).usagePath, "utf8"),
    );
    // Both jail-observed model calls contributed a usage row. No judge
    // entry because the eval_function was deterministic.
    expect(usage.requests).toHaveLength(2);
    expect(usage.totalInputTokens).toBe(1500);
    expect(usage.totalOutputTokens).toBe(130);
    expect(usage.costStatus).toBe("ok");
    // Both rows priced against the Anthropic Sonnet 4.6 row in
    // PRICING_TABLE: 1500/1M × $3 + 130/1M × $15 = $0.00645
    expect(typeof usage.totalCostUsd).toBe("number");
    expect(usage.totalCostUsd).toBeGreaterThan(0);
  });

  test("does not price usage carried on assistant-emitted events", async () => {
    const runId = `lme-v2-runner-no-event-usage-${Date.now()}`;
    runIdsToCleanup.push(runId);

    // GIVEN an agent that emits a usage event but whose egress jail
    // observed nothing (no readUsageRecords capability).
    const harness = makeFakeAgent([
      [
        textEvent("Ready."),
        usageEvent({
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          input_tokens: 9999,
          output_tokens: 9999,
        }),
      ],
      [textEvent("The laptop was blue.")],
    ]);
    nextAgent = harness.agent;

    // WHEN the run completes
    await runLongMemEvalV2Unit({
      profile: profileFor("p1"),
      item: makeItem(),
      trajectoryReader: trajectoryReader(),
      runId,
      quietMs: 50,
    });

    // THEN the emitted usage is ignored — no priced rows, no token
    // totals, and cost reads "missing" rather than reflecting the event.
    const usage = JSON.parse(
      await readFile(runArtifacts(runId).usagePath, "utf8"),
    );
    expect(usage.requests).toHaveLength(0);
    expect(usage.totalInputTokens).toBeUndefined();
    expect(usage.totalOutputTokens).toBeUndefined();
    expect(usage.totalCostUsd).toBeUndefined();
    expect(usage.costStatus).toBe("missing");
  });

  test("merges LLM judge usage into usage.json alongside assistant usage", async () => {
    const runId = `lme-v2-runner-judge-usage-${Date.now()}`;
    runIdsToCleanup.push(runId);

    const harness = makeFakeAgent(
      [
        [textEvent("Ready.")],
        // Hypothesis text that the LLM judge will grade.
        [textEvent("The premise is wrong because X.")],
      ],
      [
        {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          input_tokens: 800,
          output_tokens: 50,
        },
        {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          input_tokens: 300,
          output_tokens: 20,
        },
      ],
    );
    nextAgent = harness.agent;

    // Mock OpenAI chat completions for the LLM judge call. Returns a
    // positive judgement plus a usage block — the runner must thread
    // both through.
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"label": 1, "reason": "identified flaw"}',
              },
            },
          ],
          usage: {
            prompt_tokens: 200,
            completion_tokens: 15,
            total_tokens: 215,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;
    try {
      await runLongMemEvalV2Unit({
        profile: profileFor("p1"),
        item: makeItem({
          evalFunction: "llm_abstention_checker",
          answer: "Reject the premise.",
        }),
        trajectoryReader: trajectoryReader(),
        runId,
        quietMs: 50,
        judgeOverrides: {
          evaluatorModel: "gpt-5.2",
          evaluatorApiKey: "unit-test",
        },
      });
    } finally {
      globalThis.fetch = previousFetch;
    }

    const usage = JSON.parse(
      await readFile(runArtifacts(runId).usagePath, "utf8"),
    );
    // 2 agent rows only — the judge row is tagged `origin: "metric"` and
    // excluded from the assistant cost breakdown (per Vargas's feedback
    // that LLM calls from metrics should not appear in the Cost tab).
    expect(usage.requests).toHaveLength(2);
    // Totals roll up across the two agent rows only.
    expect(usage.totalInputTokens).toBe(800 + 300);
    expect(usage.totalOutputTokens).toBe(50 + 20);
    // The judge row must NOT appear in the per-request breakdown.
    const judgeRow = (usage.requests as Array<Record<string, unknown>>).find(
      (r) => r.source === "longmemeval-v2-judge",
    );
    expect(judgeRow).toBeUndefined();
    // Both `claude-sonnet-4-6` agent rows are in the local pricing table,
    // so usage prices cleanly: 1100 input × $3 + 70 output × $15 per 1M
    // = $0.00435. costStatus is "ok" (no diagnostics).
    expect(usage.costStatus).toBe("ok");
    expect(usage.totalCostUsd).toBeGreaterThan(0);
    expect(usage.costDiagnostics ?? []).toHaveLength(0);
  });

  test("LLM judge with no usage block: usage.json has assistant rows only", async () => {
    const runId = `lme-v2-runner-no-judge-usage-${Date.now()}`;
    runIdsToCleanup.push(runId);

    const harness = makeFakeAgent(
      [[textEvent("Ready.")], [textEvent("The premise is wrong because X.")]],
      [
        {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          input_tokens: 800,
          output_tokens: 50,
        },
      ],
    );
    nextAgent = harness.agent;

    // Judge response with no usage block — local non-OpenAI endpoints
    // sometimes skip it. We treat that as "missing" rather than
    // fabricating zeros.
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: '{"label": 1, "reason": "identified"}' } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    try {
      await runLongMemEvalV2Unit({
        profile: profileFor("p1"),
        item: makeItem({
          evalFunction: "llm_abstention_checker",
          answer: "Reject the premise.",
        }),
        trajectoryReader: trajectoryReader(),
        runId,
        quietMs: 50,
        judgeOverrides: {
          evaluatorModel: "gpt-5.2",
          evaluatorApiKey: "unit-test",
        },
      });
    } finally {
      globalThis.fetch = previousFetch;
    }

    const usage = JSON.parse(
      await readFile(runArtifacts(runId).usagePath, "utf8"),
    );
    // Only the single jail-observed assistant row; no judge row.
    expect(usage.requests).toHaveLength(1);
    expect(usage.totalInputTokens).toBe(800);
    expect(usage.totalOutputTokens).toBe(50);
  });

  test("manifest write reflects haystack order and withholds the question for blind ingest", async () => {
    const runId = `lme-v2-runner-manifest-${Date.now()}`;
    runIdsToCleanup.push(runId);

    const harness = makeFakeAgent([[textEvent("Ready.")], [textEvent("blue")]]);
    nextAgent = harness.agent;

    await runLongMemEvalV2Unit({
      profile: profileFor("p1"),
      item: makeItem({ trajectoryIds: ["t2", "t1"] }),
      trajectoryReader: trajectoryReader(),
      runId,
      quietMs: 50,
    });

    const manifestWrite = harness
      .writes()
      .find((w) => w.path === "longmemeval/manifest.json");
    expect(manifestWrite).toBeDefined();
    const manifest = JSON.parse(manifestWrite!.content);
    expect(manifest.trajectoryIds).toEqual(["t2", "t1"]);
    expect(manifest.count).toBe(2);
    // The ingested manifest must not leak the upcoming question or its
    // ability type, otherwise the ingest turn is no longer blind.
    expect(manifest.question).toBeUndefined();
    expect(manifest.ability).toBeUndefined();
  });
});
