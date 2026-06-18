import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { WorkflowJournalResponse } from "@vellumai/assistant-api";

import type {
  FetchWorkflowRunResult,
  WorkflowRunRow,
} from "@/domains/chat/fetch-workflow-run";

// Stub the journal fetch so fetchJournalIfNeeded is exercised without a
// network boundary. The mock is reassigned per-test via `journalImpl`.
let journalImpl: (
  assistantId: string,
  runId: string,
) => Promise<WorkflowJournalResponse | null> = async () => null;

mock.module("@/domains/chat/fetch-workflow-journal", () => ({
  fetchWorkflowJournal: (assistantId: string, runId: string) =>
    journalImpl(assistantId, runId),
}));

// Stub the run-row fetch the same way so hydrateRunIfNeeded is exercised
// without a network boundary.
let runImpl: (
  assistantId: string,
  runId: string,
) => Promise<FetchWorkflowRunResult> = async () => null;

mock.module("@/domains/chat/fetch-workflow-run", () => ({
  fetchWorkflowRun: (assistantId: string, runId: string) =>
    runImpl(assistantId, runId),
}));

const { useWorkflowStore } = await import("@/domains/chat/workflow-store");

function makeRunRow(overrides: Partial<WorkflowRunRow> = {}): WorkflowRunRow {
  return {
    id: "wf-1",
    name: "Build report",
    scriptHash: "hash-abc",
    status: "completed",
    conversationId: "conv-xyz",
    agentsSpawned: 2,
    inputTokens: 100,
    outputTokens: 50,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    finishedAt: NOW,
    ...overrides,
  };
}

function getState() {
  return useWorkflowStore.getState();
}

const NOW = 1700000000000;

beforeEach(() => {
  getState().reset();
  journalImpl = async () => null;
  runImpl = async () => null;
});

// ---------------------------------------------------------------------------
// startRun
// ---------------------------------------------------------------------------

describe("startRun", () => {
  it("creates a running entry and indexes byToolUseId", () => {
    getState().startRun({
      runId: "wf-1",
      toolUseId: "tu-1",
      label: "Build report",
      timestamp: NOW,
    });

    const state = getState();
    expect(state.orderedIds).toEqual(["wf-1"]);
    const entry = state.byId["wf-1"]!;
    expect(entry.status).toBe("running");
    expect(entry.label).toBe("Build report");
    expect(entry.toolUseId).toBe("tu-1");
    expect(entry.startedAt).toBe(NOW);
    expect(entry.leaves.size).toBe(0);
    expect(state.byToolUseId.get("tu-1")).toBe("wf-1");
  });

  it("does not clone byToolUseId when no toolUseId is supplied", () => {
    const before = getState().byToolUseId;
    getState().startRun({ runId: "wf-2", timestamp: NOW });
    expect(getState().byToolUseId).toBe(before);
  });

  it("fills missing label/toolUseId on a pre-existing shell entry", () => {
    getState().applyProgress({ runId: "wf-3", phase: "planning" });
    getState().startRun({
      runId: "wf-3",
      toolUseId: "tu-3",
      label: "Late label",
      timestamp: NOW,
    });

    const entry = getState().byId["wf-3"]!;
    expect(entry.label).toBe("Late label");
    expect(entry.toolUseId).toBe("tu-3");
    expect(entry.phase).toBe("planning");
    expect(getState().byToolUseId.get("tu-3")).toBe("wf-3");
    // Not double-added to the ordered list.
    expect(getState().orderedIds).toEqual(["wf-3"]);
  });
});

// ---------------------------------------------------------------------------
// applyProgress
// ---------------------------------------------------------------------------

describe("applyProgress", () => {
  it("upserts a shell entry when the run is unknown", () => {
    getState().applyProgress({
      runId: "wf-p",
      phase: "spawning",
      agentsSpawned: 3,
    });

    const entry = getState().byId["wf-p"]!;
    expect(entry.status).toBe("running");
    expect(entry.phase).toBe("spawning");
    expect(entry.agentsSpawned).toBe(3);
    expect(getState().orderedIds).toEqual(["wf-p"]);
  });
});

// ---------------------------------------------------------------------------
// Leaf lifecycle
// ---------------------------------------------------------------------------

describe("leaf lifecycle", () => {
  it("upserts a seq-keyed running leaf", () => {
    getState().startRun({ runId: "wf-l", timestamp: NOW });
    getState().leafStarted({
      runId: "wf-l",
      seq: 0,
      label: "Leaf A",
      promptSummary: "do a thing",
    });

    const leaf = getState().byId["wf-l"]!.leaves.get(0)!;
    expect(leaf.status).toBe("running");
    expect(leaf.label).toBe("Leaf A");
    expect(leaf.promptSummary).toBe("do a thing");
  });

  it("creates a shell run when leafStarted races ahead of startRun", () => {
    getState().leafStarted({ runId: "wf-race", seq: 2, label: "Early leaf" });

    const entry = getState().byId["wf-race"];
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("running");
    expect(entry!.leaves.get(2)!.status).toBe("running");
    expect(getState().orderedIds).toEqual(["wf-race"]);
  });

  it("transitions a leaf to terminal and merges tokens, keeping the prior label", () => {
    getState().leafStarted({ runId: "wf-f", seq: 0, label: "Leaf A" });
    getState().leafFinished({
      runId: "wf-f",
      seq: 0,
      status: "completed",
      inputTokens: 100,
      outputTokens: 50,
      resultSummary: "done",
    });

    const leaf = getState().byId["wf-f"]!.leaves.get(0)!;
    expect(leaf.status).toBe("completed");
    expect(leaf.label).toBe("Leaf A");
    expect(leaf.inputTokens).toBe(100);
    expect(leaf.outputTokens).toBe(50);
    expect(leaf.resultSummary).toBe("done");
  });

  it("never downgrades an already-terminal leaf back to running", () => {
    getState().leafFinished({ runId: "wf-d", seq: 0, status: "completed" });
    getState().leafStarted({ runId: "wf-d", seq: 0, label: "Stale start" });

    expect(getState().byId["wf-d"]!.leaves.get(0)!.status).toBe("completed");
  });

  it("is idempotent when leafFinished repeats the same terminal status with no new data", () => {
    getState().leafFinished({
      runId: "wf-i",
      seq: 0,
      status: "completed",
      inputTokens: 10,
    });
    const before = getState().byId["wf-i"]!.leaves;
    getState().leafFinished({ runId: "wf-i", seq: 0, status: "completed" });
    expect(getState().byId["wf-i"]!.leaves).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// completeRun
// ---------------------------------------------------------------------------

describe("completeRun", () => {
  it("sets terminal run fields", () => {
    getState().startRun({ runId: "wf-c", timestamp: NOW });
    getState().completeRun({
      runId: "wf-c",
      status: "completed",
      agentsSpawned: 4,
      inputTokens: 1000,
      outputTokens: 500,
      summary: "all good",
    });

    const entry = getState().byId["wf-c"]!;
    expect(entry.status).toBe("completed");
    expect(entry.agentsSpawned).toBe(4);
    expect(entry.inputTokens).toBe(1000);
    expect(entry.outputTokens).toBe(500);
    expect(entry.summary).toBe("all good");
  });

  it.each(["aborted", "cap_exceeded", "interrupted"] as const)(
    "sweeps a still-running leaf to cancelled when the run ends %s",
    (status) => {
      getState().leafStarted({ runId: "wf-x", seq: 0, label: "In flight" });
      getState().leafFinished({ runId: "wf-x", seq: 1, status: "completed" });
      getState().leafFinished({ runId: "wf-x", seq: 2, status: "failed" });

      getState().completeRun({
        runId: "wf-x",
        status,
        agentsSpawned: 3,
        inputTokens: 0,
        outputTokens: 0,
      });

      const leaves = getState().byId["wf-x"]!.leaves;
      // The in-flight leaf flips to cancelled; the already-terminal leaves
      // keep their status.
      expect(leaves.get(0)!.status).toBe("cancelled");
      expect(leaves.get(1)!.status).toBe("completed");
      expect(leaves.get(2)!.status).toBe("failed");
    },
  );

  it("preserves leaf fields when sweeping it to cancelled", () => {
    getState().leafStarted({
      runId: "wf-keepfields",
      seq: 0,
      label: "In flight",
      promptSummary: "do a thing",
    });

    getState().completeRun({
      runId: "wf-keepfields",
      status: "aborted",
      agentsSpawned: 1,
      inputTokens: 0,
      outputTokens: 0,
    });

    const leaf = getState().byId["wf-keepfields"]!.leaves.get(0)!;
    expect(leaf.status).toBe("cancelled");
    expect(leaf.label).toBe("In flight");
    expect(leaf.promptSummary).toBe("do a thing");
  });

  it("keeps the leaves Map reference stable for a clean run with no running leaves", () => {
    getState().leafStarted({ runId: "wf-clean", seq: 0, label: "Leaf" });
    getState().leafFinished({ runId: "wf-clean", seq: 0, status: "completed" });
    const before = getState().byId["wf-clean"]!.leaves;

    getState().completeRun({
      runId: "wf-clean",
      status: "completed",
      agentsSpawned: 1,
      inputTokens: 0,
      outputTokens: 0,
    });

    expect(getState().byId["wf-clean"]!.leaves).toBe(before);
  });

  it("does not regress a cancelled leaf back to running on a late leafStarted", () => {
    getState().leafStarted({ runId: "wf-late", seq: 0, label: "In flight" });
    getState().completeRun({
      runId: "wf-late",
      status: "aborted",
      agentsSpawned: 1,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(getState().byId["wf-late"]!.leaves.get(0)!.status).toBe("cancelled");

    // A late/duplicate start event must not resurrect a terminal leaf.
    getState().leafStarted({ runId: "wf-late", seq: 0, label: "Stale start" });
    expect(getState().byId["wf-late"]!.leaves.get(0)!.status).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------
// backfillFromJournal
// ---------------------------------------------------------------------------

describe("backfillFromJournal", () => {
  it("inserts missing leaves and sets run counters", () => {
    getState().startRun({ runId: "wf-bf", timestamp: NOW });
    getState().backfillFromJournal("wf-bf", {
      runId: "wf-bf",
      status: "running",
      agentsSpawned: 2,
      inputTokens: 200,
      outputTokens: 100,
      phase: "executing",
      leaves: [
        {
          seq: 0,
          kind: "agent",
          label: "Leaf 0",
          status: "completed",
          createdAt: NOW,
        },
        {
          seq: 1,
          kind: "agent",
          label: "Leaf 1",
          status: "failed",
          createdAt: NOW,
        },
      ],
    });

    const entry = getState().byId["wf-bf"]!;
    expect(entry.agentsSpawned).toBe(2);
    expect(entry.inputTokens).toBe(200);
    expect(entry.phase).toBe("executing");
    expect(entry.leaves.get(0)!.status).toBe("completed");
    expect(entry.leaves.get(1)!.status).toBe("failed");
  });

  it("does not regress a live terminal leaf when the journal reports it", () => {
    getState().leafStarted({ runId: "wf-keep", seq: 0, label: "Live leaf" });
    getState().leafFinished({
      runId: "wf-keep",
      seq: 0,
      status: "completed",
      resultSummary: "live result",
    });

    getState().backfillFromJournal("wf-keep", {
      runId: "wf-keep",
      leaves: [
        {
          seq: 0,
          kind: "agent",
          status: "failed",
          resultSummary: "journal result",
          createdAt: NOW,
        },
      ],
    });

    const leaf = getState().byId["wf-keep"]!.leaves.get(0)!;
    // Live terminal wins: status and result are preserved.
    expect(leaf.status).toBe("completed");
    expect(leaf.resultSummary).toBe("live result");
  });

  it("lets a journal terminal status override a stale live running leaf", () => {
    getState().leafStarted({ runId: "wf-win", seq: 0, label: "Running leaf" });

    getState().backfillFromJournal("wf-win", {
      runId: "wf-win",
      leaves: [
        {
          seq: 0,
          kind: "agent",
          status: "completed",
          resultSummary: "journal result",
          createdAt: NOW,
        },
      ],
    });

    const leaf = getState().byId["wf-win"]!.leaves.get(0)!;
    expect(leaf.status).toBe("completed");
    expect(leaf.label).toBe("Running leaf");
    expect(leaf.resultSummary).toBe("journal result");
  });

  it("lets a journal terminal status repair a leaf swept to cancelled", () => {
    // A run completes but one leaf's finish event was dropped, so completeRun
    // swept the still-running leaf to "cancelled".
    getState().leafStarted({ runId: "wf-repair", seq: 0, label: "Dropped-finish" });
    getState().completeRun({
      runId: "wf-repair",
      status: "completed",
      agentsSpawned: 1,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(getState().byId["wf-repair"]!.leaves.get(0)!.status).toBe("cancelled");

    // The journal holds the authoritative completed row → it repairs the placeholder.
    getState().backfillFromJournal("wf-repair", {
      runId: "wf-repair",
      leaves: [
        {
          seq: 0,
          kind: "agent",
          status: "completed",
          resultSummary: "real result",
          createdAt: NOW,
        },
      ],
    });

    const leaf = getState().byId["wf-repair"]!.leaves.get(0)!;
    expect(leaf.status).toBe("completed");
    expect(leaf.label).toBe("Dropped-finish");
    expect(leaf.resultSummary).toBe("real result");
  });

  it("leaves a genuinely cancelled leaf (absent from the journal) as cancelled", () => {
    getState().leafStarted({ runId: "wf-genuine", seq: 0, label: "Aborted leaf" });
    getState().completeRun({
      runId: "wf-genuine",
      status: "aborted",
      agentsSpawned: 1,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(getState().byId["wf-genuine"]!.leaves.get(0)!.status).toBe("cancelled");

    // The journal has no row for this leaf (it never finished) → it stays cancelled.
    getState().backfillFromJournal("wf-genuine", { runId: "wf-genuine", leaves: [] });

    expect(getState().byId["wf-genuine"]!.leaves.get(0)!.status).toBe("cancelled");
  });

  it("does not regress a terminal run from a stale (running) journal response", () => {
    // The panel opened mid-run (a :live journal request is in flight), then
    // workflow_completed lands and marks the entry terminal with final counters.
    getState().completeRun({
      runId: "wf-race",
      status: "completed",
      agentsSpawned: 5,
      inputTokens: 900,
      outputTokens: 300,
    });

    // The stale :live response resolves afterwards with mid-run (lower) values.
    getState().backfillFromJournal("wf-race", {
      runId: "wf-race",
      status: "running",
      agentsSpawned: 2,
      inputTokens: 100,
      outputTokens: 40,
      leaves: [],
    });

    const entry = getState().byId["wf-race"]!;
    expect(entry.status).toBe("completed");
    expect(entry.agentsSpawned).toBe(5);
    expect(entry.inputTokens).toBe(900);
    expect(entry.outputTokens).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// fetchJournalIfNeeded
// ---------------------------------------------------------------------------

describe("fetchJournalIfNeeded", () => {
  it("dedups a second call within the same (run, phase)", async () => {
    getState().startRun({ runId: "wf-fetch", timestamp: NOW });

    let calls = 0;
    journalImpl = async (_assistantId, runId) => {
      calls += 1;
      return { runId, leaves: [] };
    };

    await getState().fetchJournalIfNeeded("asst-1", "wf-fetch");
    await getState().fetchJournalIfNeeded("asst-1", "wf-fetch");

    expect(calls).toBe(1);
    // A running run is keyed under its `:live` phase.
    expect(getState().fetchedAt.get("wf-fetch:live")).toBe(NOW);
  });

  it("performs a second fetch once the run goes terminal", async () => {
    getState().startRun({ runId: "wf-phase", timestamp: NOW });

    let calls = 0;
    journalImpl = async (_assistantId, runId) => {
      calls += 1;
      return { runId, leaves: [] };
    };

    // Live fetch.
    await getState().fetchJournalIfNeeded("asst-1", "wf-phase");
    expect(calls).toBe(1);

    // Run finishes — a fresh `:final` key allows one more reconcile.
    getState().completeRun({
      runId: "wf-phase",
      status: "completed",
      agentsSpawned: 1,
      inputTokens: 0,
      outputTokens: 0,
    });
    await getState().fetchJournalIfNeeded("asst-1", "wf-phase");
    await getState().fetchJournalIfNeeded("asst-1", "wf-phase");

    expect(calls).toBe(2);
    expect(getState().fetchedAt.get("wf-phase:live")).toBe(NOW);
    expect(getState().fetchedAt.get("wf-phase:final")).toBe(NOW);
  });

  it("clears the phase marker on failure so callers can retry", async () => {
    getState().startRun({ runId: "wf-fail", timestamp: NOW });

    journalImpl = async () => null;
    await getState().fetchJournalIfNeeded("asst-1", "wf-fail");

    expect(getState().fetchedAt.has("wf-fail:live")).toBe(false);
  });

  it("no-ops when the run is unknown", async () => {
    let calls = 0;
    journalImpl = async (_assistantId, runId) => {
      calls += 1;
      return { runId, leaves: [] };
    };
    await getState().fetchJournalIfNeeded("asst-1", "missing");
    expect(calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// hydrateRunIfNeeded
// ---------------------------------------------------------------------------

describe("hydrateRunIfNeeded", () => {
  it("populates a terminal run from its row and journal when absent", async () => {
    runImpl = async () =>
      makeRunRow({
        id: "wf-hy",
        name: "History run",
        status: "completed",
        agentsSpawned: 2,
        inputTokens: 100,
        outputTokens: 50,
      });
    journalImpl = async (_assistantId, runId) => ({
      runId,
      leaves: [
        { seq: 0, kind: "agent", label: "Leaf 0", status: "completed", createdAt: NOW },
      ],
    });

    await getState().hydrateRunIfNeeded("asst-1", "wf-hy");

    const entry = getState().byId["wf-hy"]!;
    expect(entry.status).toBe("completed");
    expect(entry.label).toBe("History run");
    expect(entry.agentsSpawned).toBe(2);
    expect(entry.inputTokens).toBe(100);
    expect(entry.outputTokens).toBe(50);
    expect(entry.leaves.get(0)!.status).toBe("completed");
    expect(getState().orderedIds).toEqual(["wf-hy"]);
  });

  it("hydrates a still-running run via applyProgress (no terminal counters)", async () => {
    runImpl = async () =>
      makeRunRow({ id: "wf-live", status: "running", agentsSpawned: 3 });
    journalImpl = async (_assistantId, runId) => ({ runId, leaves: [] });

    await getState().hydrateRunIfNeeded("asst-1", "wf-live");

    const entry = getState().byId["wf-live"]!;
    expect(entry.status).toBe("running");
    expect(entry.agentsSpawned).toBe(3);
  });

  it("does not clobber an existing live entry", async () => {
    getState().startRun({ runId: "wf-live2", label: "Live", timestamp: NOW });

    let calls = 0;
    runImpl = async () => {
      calls += 1;
      return makeRunRow({ id: "wf-live2" });
    };

    await getState().hydrateRunIfNeeded("asst-1", "wf-live2");

    expect(calls).toBe(0);
    expect(getState().byId["wf-live2"]!.label).toBe("Live");
  });

  it("attempts the fetch at most once per run", async () => {
    let calls = 0;
    runImpl = async () => {
      calls += 1;
      return makeRunRow({ id: "wf-dedup" });
    };

    await getState().hydrateRunIfNeeded("asst-1", "wf-dedup");
    await getState().hydrateRunIfNeeded("asst-1", "wf-dedup");

    expect(calls).toBe(1);
  });

  it("leaves no entry and stays marked when the run is unknown (404)", async () => {
    let calls = 0;
    runImpl = async () => {
      calls += 1;
      return "not_found";
    };

    await getState().hydrateRunIfNeeded("asst-1", "wf-404");
    // Re-attempt is suppressed even though no entry was created.
    await getState().hydrateRunIfNeeded("asst-1", "wf-404");

    expect(calls).toBe(1);
    expect(getState().byId["wf-404"]).toBeUndefined();
    expect(getState().hydratedRunIds.has("wf-404")).toBe(true);
    // Recorded as not-found so the transcript un-suppresses its chip.
    expect(getState().notFoundRunIds.has("wf-404")).toBe(true);
  });

  it("retries after a transient failure (clears the marker)", async () => {
    let calls = 0;
    // First attempt fails transiently (daemon unreachable); the second succeeds.
    runImpl = async () => {
      calls += 1;
      return calls === 1 ? null : makeRunRow({ id: "wf-flaky", status: "completed" });
    };
    journalImpl = async (_assistantId, runId) => ({ runId, leaves: [] });

    await getState().hydrateRunIfNeeded("asst-1", "wf-flaky");
    // The transient failure cleared the marker, so it is no longer suppressed.
    expect(getState().hydratedRunIds.has("wf-flaky")).toBe(false);
    expect(getState().byId["wf-flaky"]).toBeUndefined();

    await getState().hydrateRunIfNeeded("asst-1", "wf-flaky");

    expect(calls).toBe(2);
    expect(getState().byId["wf-flaky"]!.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

describe("reset", () => {
  it("clears all runs, ordering, and indexes", async () => {
    getState().startRun({ runId: "wf-r", toolUseId: "tu-r", timestamp: NOW });
    getState().leafStarted({ runId: "wf-r", seq: 0, label: "Leaf" });
    // Mark a 404'd run so the hydrated + not-found sets are non-empty before reset.
    runImpl = async () => "not_found";
    await getState().hydrateRunIfNeeded("asst-1", "wf-404");

    getState().reset();

    const state = getState();
    expect(state.byId).toEqual({});
    expect(state.orderedIds).toEqual([]);
    expect(state.byToolUseId.size).toBe(0);
    expect(state.fetchedAt.size).toBe(0);
    expect(state.hydratedRunIds.size).toBe(0);
    expect(state.notFoundRunIds.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Reference stability
// ---------------------------------------------------------------------------

describe("reference stability", () => {
  it("leaves another run's leaves Map reference unchanged on mutation", () => {
    getState().startRun({ runId: "wf-a", timestamp: NOW });
    getState().startRun({ runId: "wf-b", timestamp: NOW });
    const bLeavesBefore = getState().byId["wf-b"]!.leaves;

    getState().leafStarted({ runId: "wf-a", seq: 0, label: "A leaf" });

    expect(getState().byId["wf-b"]!.leaves).toBe(bLeavesBefore);
  });
});
