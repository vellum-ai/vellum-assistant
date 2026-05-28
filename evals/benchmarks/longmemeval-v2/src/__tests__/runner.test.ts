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
import type { TrajectoryRecord } from "../trajectories";

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

interface FakeAgentHarness {
  agent: BaseAgent;
  writes: () => WorkspaceFileWrite[];
  sends: () => string[];
}

function makeFakeAgent(responses: AgentEvent[][]): FakeAgentHarness {
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
  };

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

function trajectoryMap(): Map<string, TrajectoryRecord> {
  return new Map([
    ["t1", { id: "t1", domain: "web", states: [{ a: 1 }] }],
    ["t2", { id: "t2", domain: "web", states: [{ a: 2 }] }],
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
      trajectories: trajectoryMap(),
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

    // transcript.json carries the three-turn shape
    const transcript = JSON.parse(
      await readFile(runArtifacts(runId).transcriptPath, "utf8"),
    );
    expect(transcript).toHaveLength(3);
    expect(transcript[0].role).toBe("simulator");
    expect(transcript[1].role).toBe("simulator");
    expect(transcript[1].content).toBe(
      "What color was the laptop in the screenshot?",
    );
    expect(transcript[2].role).toBe("assistant");
    expect(transcript[2].content).toBe("The laptop was blue.");

    // Progress events: artifacts/setup/send/metrics/result
    const steps = events.map((e) => `${e.step}:${e.status}`);
    expect(steps).toContain("artifacts:done");
    expect(steps).toContain("setup:done");
    expect(steps).toContain("send:done");
    expect(steps).toContain("metrics:done");
    expect(steps).toContain("result:done");
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
      trajectories: trajectoryMap(),
      runId,
      quietMs: 50,
    });

    expect(result.metrics[0]!.score).toBe(0);
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
        trajectories: trajectoryMap(),
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

  test("manifest write reflects haystack order and ability", async () => {
    const runId = `lme-v2-runner-manifest-${Date.now()}`;
    runIdsToCleanup.push(runId);

    const harness = makeFakeAgent([[textEvent("Ready.")], [textEvent("blue")]]);
    nextAgent = harness.agent;

    await runLongMemEvalV2Unit({
      profile: profileFor("p1"),
      item: makeItem({ trajectoryIds: ["t2", "t1"] }),
      trajectories: trajectoryMap(),
      runId,
      quietMs: 50,
    });

    const manifestWrite = harness
      .writes()
      .find((w) => w.path === "longmemeval/manifest.json");
    expect(manifestWrite).toBeDefined();
    const manifest = JSON.parse(manifestWrite!.content);
    expect(manifest.trajectoryIds).toEqual(["t2", "t1"]);
    expect(manifest.ability).toBe("static-state-recall");
    expect(manifest.count).toBe(2);
  });
});
