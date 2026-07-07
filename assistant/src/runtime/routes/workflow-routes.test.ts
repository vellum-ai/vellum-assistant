import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ExternalConversationBinding } from "../../persistence/external-conversation-store.js";
import type {
  WorkflowJournalEntry,
  WorkflowRun,
} from "../../workflows/journal-store.js";
import type { SavedWorkflowEntry } from "../../workflows/library.js";
import {
  WorkflowResumeNotPossibleError,
  WorkflowRunCapError,
} from "../../workflows/run-manager.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
} from "./errors.js";
import type { RouteDefinition } from "./types.js";
import { __setWorkflowRoutesDeps, ROUTES } from "./workflow-routes.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function route(operationId: string): RouteDefinition {
  const r = ROUTES.find((x) => x.operationId === operationId);
  if (!r) throw new Error(`No route for ${operationId}`);
  return r;
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-1",
    name: "demo",
    scriptSource: "export const meta = { name: 'demo' }",
    scriptHash: "hash-1",
    args: null,
    capabilities: null,
    status: "running",
    conversationId: null,
    trust: null,
    agentsSpawned: 2,
    inputTokens: 10,
    outputTokens: 5,
    result: null,
    error: null,
    createdAt: 1000,
    updatedAt: 2000,
    finishedAt: null,
    ...overrides,
  };
}

interface FakeManager {
  list: (opts?: {
    limit?: number;
    status?: WorkflowRun["status"];
  }) => WorkflowRun[];
  status: (id: string) => WorkflowRun | null;
  abort: (id: string) => void;
  resume: (id: string) => { runId: string };
}

function makeJournalEntry(
  overrides: Partial<WorkflowJournalEntry> = {},
): WorkflowJournalEntry {
  return {
    runId: "run-1",
    seq: 0,
    callHash: "call-0",
    kind: "agent",
    request: null,
    result: null,
    status: "completed",
    createdAt: 1000,
    ...overrides,
  };
}

function setup(opts: {
  runs?: WorkflowRun[];
  saved?: SavedWorkflowEntry[];
  /** Custom resume impl; defaults to a success that records the id. */
  resume?: (id: string) => { runId: string };
  /** Resolved auto-approve threshold for the resume posture gate. */
  threshold?: "none" | "low" | "medium" | "high";
  /** Journal entries returned by getJournal, keyed by run id. */
  journal?: Record<string, WorkflowJournalEntry[]>;
  /** externalChatId returned by the binding lookup (Slack channel id). */
  bindingExternalChatId?: string;
}): {
  aborted: string[];
  resumed: string[];
  listCalls: Array<{ limit?: number; status?: string }>;
  thresholdCalls: Array<{
    conversationId?: string;
    executionContext?: string;
    cellQuery?: unknown;
  }>;
} {
  const runs = opts.runs ?? [];
  const aborted: string[] = [];
  const resumed: string[] = [];
  const listCalls: Array<{ limit?: number; status?: string }> = [];
  const thresholdCalls: Array<{
    conversationId?: string;
    executionContext?: string;
    cellQuery?: unknown;
  }> = [];
  const manager: FakeManager = {
    list: (o) => {
      listCalls.push({ limit: o?.limit, status: o?.status });
      let result = runs;
      if (o?.status) result = result.filter((r) => r.status === o.status);
      if (o?.limit !== undefined) result = result.slice(0, o.limit);
      return result;
    },
    status: (id) => runs.find((r) => r.id === id) ?? null,
    abort: (id) => {
      aborted.push(id);
    },
    resume:
      opts.resume ??
      ((id) => {
        resumed.push(id);
        return { runId: id };
      }),
  };
  __setWorkflowRoutesDeps({
    getManager: () => manager,
    listWorkflows: () => opts.saved ?? [],
    getAutoApproveThreshold: async (
      conversationId,
      executionContext,
      cellQuery,
    ) => {
      thresholdCalls.push({ conversationId, executionContext, cellQuery });
      return opts.threshold ?? "none";
    },
    getBindingByConversation: (conversationId: string) =>
      opts.bindingExternalChatId
        ? ({
            conversationId,
            externalChatId: opts.bindingExternalChatId,
          } as ExternalConversationBinding)
        : null,
    getJournal: (runId) => opts.journal?.[runId] ?? [],
  });
  return { aborted, resumed, listCalls, thresholdCalls };
}

afterEach(() => {
  __setWorkflowRoutesDeps();
});

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe("workflow routes (happy paths)", () => {
  beforeEach(() => {
    setup({
      runs: [
        makeRun({ id: "run-1" }),
        makeRun({ id: "run-2", status: "completed" }),
      ],
      saved: [
        {
          name: "nightly",
          description: "Nightly job",
          path: "/w/nightly.workflow.ts",
        },
      ],
    });
  });

  test("listWorkflowRuns returns wire runs", async () => {
    const result = (await route("listWorkflowRuns").handler({
      queryParams: {},
    })) as {
      runs: Array<{ id: string; scriptHash: string }>;
    };
    expect(result.runs.map((r) => r.id)).toEqual(["run-1", "run-2"]);
    // Bulky fields are dropped from the wire shape.
    expect(result.runs[0]).not.toHaveProperty("scriptSource");
    expect(result.runs[0].scriptHash).toBe("hash-1");
  });

  test("listWorkflowRuns honors limit + status query params", async () => {
    const { listCalls } = setup({
      runs: [makeRun({ id: "run-1", status: "completed" })],
    });
    await route("listWorkflowRuns").handler({
      queryParams: { limit: "5", status: "completed" },
    });
    expect(listCalls.at(-1)).toEqual({ limit: 5, status: "completed" });
  });

  test("getWorkflowRun returns a single run", async () => {
    const result = (await route("getWorkflowRun").handler({
      pathParams: { id: "run-1" },
    })) as { id: string };
    expect(result.id).toBe("run-1");
  });

  test("abortWorkflowRun aborts a known run", async () => {
    const { aborted } = setup({
      runs: [makeRun({ id: "run-1" })],
    });
    const result = (await route("abortWorkflowRun").handler({
      pathParams: { id: "run-1" },
    })) as { ok: boolean; runId: string };
    expect(result).toEqual({ ok: true, runId: "run-1" });
    expect(aborted).toEqual(["run-1"]);
  });

  test("resumeWorkflowRun resumes an interrupted run", async () => {
    const { resumed } = setup({
      runs: [makeRun({ id: "run-1", status: "interrupted" })],
    });
    const result = (await route("resumeWorkflowRun").handler({
      pathParams: { id: "run-1" },
    })) as { ok: boolean; runId: string };
    expect(result).toEqual({ ok: true, runId: "run-1" });
    expect(resumed).toEqual(["run-1"]);
  });

  test("resumeWorkflowRun rejects a side-effecting run with a 403 in normal posture", async () => {
    // The run's stored manifest grants side-effecting tools, so resuming would
    // restart leaves that perform them. This route has no interactive approval
    // channel (unlike the conversational manage_workflows path), so outside
    // full-access posture it must refuse rather than silently bypass consent —
    // resume() is never called.
    const { resumed } = setup({
      threshold: "medium",
      runs: [
        makeRun({
          id: "run-1",
          status: "interrupted",
          capabilities: { tools: ["bash"], hostFunctions: [], persona: false },
        }),
      ],
    });
    await expect(
      route("resumeWorkflowRun").handler({ pathParams: { id: "run-1" } }),
    ).rejects.toThrow(ForbiddenError);
    expect(resumed).toEqual([]);
  });

  test("resumeWorkflowRun allows a side-effecting run at full-access posture", async () => {
    // At full access ("high") the user has opted into auto-approving even
    // high-risk tools, so no prompt is needed — the side-effecting resume
    // proceeds directly.
    const { resumed } = setup({
      threshold: "high",
      runs: [
        makeRun({
          id: "run-1",
          status: "interrupted",
          capabilities: { tools: ["bash"], hostFunctions: [], persona: false },
        }),
      ],
    });
    const result = (await route("resumeWorkflowRun").handler({
      pathParams: { id: "run-1" },
    })) as { ok: boolean; runId: string };
    expect(result).toEqual({ ok: true, runId: "run-1" });
    expect(resumed).toEqual(["run-1"]);
  });

  test("resumeWorkflowRun consent gate consults the channel-permission cell for channel-originated runs", async () => {
    // The run's persisted trust snapshot carries its originating channel
    // coordinates; the gate must thread them into the threshold read so a
    // strict channel cell governs the no-prompt resume instead of a
    // possibly-looser global. The coordinates mirror what live tool calls
    // use: adapter = sourceChannel, contact-type = trustClass, channel ID
    // from the conversation binding.
    const { thresholdCalls } = setup({
      threshold: "high",
      bindingExternalChatId: "C123",
      runs: [
        makeRun({
          id: "run-1",
          status: "interrupted",
          conversationId: "conv-1",
          trust: { sourceChannel: "slack", trustClass: "trusted_contact" },
          capabilities: { tools: ["bash"], hostFunctions: [], persona: false },
        }),
      ],
    });
    await route("resumeWorkflowRun").handler({ pathParams: { id: "run-1" } });

    expect(thresholdCalls).toEqual([
      {
        conversationId: "conv-1",
        executionContext: "conversation",
        cellQuery: {
          adapter: "slack",
          channelType: undefined,
          channelExternalId: "C123",
          contactType: "trusted_contact",
        },
      },
    ]);
  });

  test("resumeWorkflowRun consent gate carries the channel ID for non-Slack adapters too", async () => {
    // The binding's external chat id is the canonical conversation address
    // for every channel adapter, so a Telegram-originated run threads its
    // chat id into the gate the same way a Slack run does — a strict
    // channel-scoped Telegram cell must govern the no-prompt resume.
    const { thresholdCalls } = setup({
      threshold: "high",
      bindingExternalChatId: "-1001234500000",
      runs: [
        makeRun({
          id: "run-1",
          status: "interrupted",
          conversationId: "conv-1",
          trust: { sourceChannel: "telegram", trustClass: "trusted_contact" },
          capabilities: { tools: ["bash"], hostFunctions: [], persona: false },
        }),
      ],
    });
    await route("resumeWorkflowRun").handler({ pathParams: { id: "run-1" } });

    expect(thresholdCalls[0].cellQuery).toEqual({
      adapter: "telegram",
      channelType: undefined,
      channelExternalId: "-1001234500000",
      contactType: "trusted_contact",
    });
  });

  test("resumeWorkflowRun consent gate builds no cell query without channel coordinates", async () => {
    // Desktop/internal runs (no trust snapshot, or no source channel) have
    // no channel coordinates — the threshold read must fall through to the
    // conversation override / global cascade exactly as before.
    const { thresholdCalls } = setup({
      threshold: "high",
      runs: [
        makeRun({
          id: "run-1",
          status: "interrupted",
          trust: null,
          capabilities: { tools: ["bash"], hostFunctions: [], persona: false },
        }),
      ],
    });
    await route("resumeWorkflowRun").handler({ pathParams: { id: "run-1" } });

    expect(thresholdCalls).toHaveLength(1);
    expect(thresholdCalls[0].cellQuery).toBeUndefined();
  });

  test("resumeWorkflowRun rejects a run stored in the older RESOLVED shape", async () => {
    // Some interrupted runs persisted resolved Tool objects (not string names).
    // resume() recovers those names and grants the tools, so the gate must catch
    // the object shape too — a strict parse would treat it as read-only and let
    // the side-effecting resume through without approval.
    const { resumed } = setup({
      threshold: "medium",
      runs: [
        makeRun({
          id: "run-1",
          status: "interrupted",
          capabilities: { tools: [{ name: "bash" }] } as unknown as Record<
            string,
            unknown
          >,
        }),
      ],
    });
    await expect(
      route("resumeWorkflowRun").handler({ pathParams: { id: "run-1" } }),
    ).rejects.toThrow(ForbiddenError);
    expect(resumed).toEqual([]);
  });

  test("resumeWorkflowRun allows a read-only run (empty manifest) in normal posture", async () => {
    // An explicit empty manifest grants no side effects, so the route resumes
    // it directly — the gate keys on the stored manifest, not run existence.
    const { resumed } = setup({
      threshold: "medium",
      runs: [
        makeRun({
          id: "run-1",
          status: "interrupted",
          capabilities: { tools: [], hostFunctions: [], persona: false },
        }),
      ],
    });
    await route("resumeWorkflowRun").handler({ pathParams: { id: "run-1" } });
    expect(resumed).toEqual(["run-1"]);
  });

  test("resumeWorkflowRun maps a non-interrupted run to a 409 ConflictError", async () => {
    setup({
      runs: [makeRun({ id: "run-1", status: "completed" })],
      resume: (id) => {
        throw new WorkflowResumeNotPossibleError(
          id,
          "not_interrupted",
          "completed",
        );
      },
    });
    await expect(
      route("resumeWorkflowRun").handler({ pathParams: { id: "run-1" } }),
    ).rejects.toThrow(ConflictError);
  });

  test("resumeWorkflowRun maps a cap error to a 429 TooManyRequestsError", async () => {
    setup({
      runs: [makeRun({ id: "run-1", status: "interrupted" })],
      resume: () => {
        throw new WorkflowRunCapError(3);
      },
    });
    await expect(
      route("resumeWorkflowRun").handler({ pathParams: { id: "run-1" } }),
    ).rejects.toThrow(TooManyRequestsError);
  });

  test("listSavedWorkflows returns saved entries", async () => {
    const result = (await route("listSavedWorkflows").handler({})) as {
      workflows: SavedWorkflowEntry[];
    };
    expect(result.workflows).toEqual([
      {
        name: "nightly",
        description: "Nightly job",
        path: "/w/nightly.workflow.ts",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Journal projection
// ---------------------------------------------------------------------------

interface WireLeaf {
  seq: number;
  kind: string;
  label?: string;
  phase?: string;
  promptSummary?: string;
  status: string;
  resultSummary?: string;
  inputTokens?: number;
  outputTokens?: number;
  createdAt: number | null;
}

interface WireJournal {
  runId: string;
  status: string;
  agentsSpawned: number;
  inputTokens: number;
  outputTokens: number;
  leaves: WireLeaf[];
}

describe("getWorkflowRunJournal", () => {
  test("projects agent leaves with label/phase/promptSummary/resultSummary extracted", async () => {
    setup({
      runs: [makeRun({ id: "run-1" })],
      journal: {
        "run-1": [
          makeJournalEntry({
            seq: 0,
            kind: "agent",
            request: {
              prompt: "Investigate the failing build",
              opts: { label: "investigate", phase: "triage" },
            },
            result: { summary: "found the flaky test" },
            status: "completed",
            inputTokens: 120,
            outputTokens: 45,
          }),
        ],
      },
    });
    const result = (await route("getWorkflowRunJournal").handler({
      pathParams: { id: "run-1" },
    })) as WireJournal;

    expect(result.runId).toBe("run-1");
    expect(result.status).toBe("running");
    expect(result.agentsSpawned).toBe(2);
    expect(result.leaves.map((l) => l.seq)).toEqual([0]);

    const first = result.leaves[0];
    expect(first.kind).toBe("agent");
    expect(first.label).toBe("investigate");
    expect(first.phase).toBe("triage");
    expect(first.promptSummary).toBe("Investigate the failing build");
    expect(first.resultSummary).toContain("found the flaky test");
    // Per-leaf token usage is projected onto the wire leaf.
    expect(first.inputTokens).toBe(120);
    expect(first.outputTokens).toBe(45);
    // The bulky raw request/result payloads are dropped.
    expect(first).not.toHaveProperty("request");
    expect(first).not.toHaveProperty("result");
  });

  test("omits per-leaf token fields when the journal entry carries none", async () => {
    setup({
      runs: [makeRun({ id: "run-1" })],
      journal: {
        "run-1": [
          makeJournalEntry({
            seq: 0,
            kind: "agent",
            request: { prompt: "no tokens recorded", opts: {} },
            status: "completed",
          }),
        ],
      },
    });
    const result = (await route("getWorkflowRunJournal").handler({
      pathParams: { id: "run-1" },
    })) as WireJournal;

    const leaf = result.leaves[0];
    expect(leaf).not.toHaveProperty("inputTokens");
    expect(leaf).not.toHaveProperty("outputTokens");
  });

  test("excludes kind:workflow entries so the backfill matches the live agent-only stream", async () => {
    // The live `workflow_leaf_*` stream is emitted only for agent leaves; nested
    // `workflow(name)` resolutions never reach it. The journal route must filter
    // to agent leaves too, or a nested-workflow run renders a phantom unlabeled
    // node on backfill and a different leaf set than live.
    setup({
      runs: [makeRun({ id: "run-1" })],
      journal: {
        "run-1": [
          makeJournalEntry({
            seq: 0,
            kind: "agent",
            request: { prompt: "first agent", opts: { label: "first" } },
            status: "completed",
          }),
          makeJournalEntry({
            seq: 1,
            kind: "workflow",
            request: { name: "child", args: { foo: 1 } },
            result: "child done",
            status: "completed",
          }),
          makeJournalEntry({
            seq: 2,
            kind: "agent",
            request: { prompt: "second agent", opts: { label: "second" } },
            status: "completed",
          }),
        ],
      },
    });
    const result = (await route("getWorkflowRunJournal").handler({
      pathParams: { id: "run-1" },
    })) as WireJournal;

    // Only the agent leaves survive, in seq order; the workflow-kind entry (seq
    // 1) is dropped entirely.
    expect(result.leaves.map((l) => l.seq)).toEqual([0, 2]);
    expect(result.leaves.every((l) => l.kind === "agent")).toBe(true);
    expect(result.leaves.map((l) => l.label)).toEqual(["first", "second"]);
  });

  test("surfaces a failed leaf's { error } result as resultSummary", async () => {
    setup({
      runs: [makeRun({ id: "run-1" })],
      journal: {
        "run-1": [
          makeJournalEntry({
            seq: 0,
            status: "failed",
            request: { prompt: "do the thing", opts: {} },
            result: { error: "agent crashed: out of tokens" },
          }),
        ],
      },
    });
    const result = (await route("getWorkflowRunJournal").handler({
      pathParams: { id: "run-1" },
    })) as WireJournal;

    expect(result.leaves[0].status).toBe("failed");
    expect(result.leaves[0].resultSummary).toContain(
      "agent crashed: out of tokens",
    );
  });

  test("truncates a long prompt/result to ~200 chars", async () => {
    const longPrompt = "x".repeat(500);
    const longResult = "y".repeat(500);
    setup({
      runs: [makeRun({ id: "run-1" })],
      journal: {
        "run-1": [
          makeJournalEntry({
            seq: 0,
            request: { prompt: longPrompt, opts: {} },
            result: longResult,
          }),
        ],
      },
    });
    const result = (await route("getWorkflowRunJournal").handler({
      pathParams: { id: "run-1" },
    })) as WireJournal;

    const leaf = result.leaves[0];
    expect(leaf.promptSummary!.length).toBeLessThanOrEqual(201);
    expect(leaf.promptSummary!.startsWith("x")).toBe(true);
    // A truncated summary ends with the ellipsis marker.
    expect(leaf.promptSummary!.endsWith("…")).toBe(true);
    expect(leaf.resultSummary!.length).toBeLessThanOrEqual(201);
  });

  test("returns an empty leaf list for a run with no journal entries", async () => {
    setup({ runs: [makeRun({ id: "run-1" })] });
    const result = (await route("getWorkflowRunJournal").handler({
      pathParams: { id: "run-1" },
    })) as WireJournal;
    expect(result.leaves).toEqual([]);
  });

  test("throws NotFoundError for an unknown id", () => {
    setup({ runs: [] });
    expect(() =>
      route("getWorkflowRunJournal").handler({ pathParams: { id: "nope" } }),
    ).toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Unknown run → 404
// ---------------------------------------------------------------------------

describe("workflow routes (unknown run)", () => {
  test("getWorkflowRun throws NotFoundError for an unknown id", () => {
    setup({ runs: [] });
    expect(() =>
      route("getWorkflowRun").handler({ pathParams: { id: "nope" } }),
    ).toThrow(NotFoundError);
  });

  test("abortWorkflowRun throws NotFoundError for an unknown id", () => {
    const { aborted } = setup({ runs: [] });
    expect(() =>
      route("abortWorkflowRun").handler({ pathParams: { id: "nope" } }),
    ).toThrow(NotFoundError);
    expect(aborted).toEqual([]);
  });

  test("resumeWorkflowRun throws NotFoundError for an unknown id", async () => {
    const { resumed } = setup({ runs: [] });
    await expect(
      route("resumeWorkflowRun").handler({ pathParams: { id: "nope" } }),
    ).rejects.toThrow(NotFoundError);
    expect(resumed).toEqual([]);
  });
});
