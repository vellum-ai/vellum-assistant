import { beforeEach, describe, expect, mock, test } from "bun:test";

// Silence the logger everywhere this graph reaches.
const realLogger = await import("../../util/logger.js");
mock.module("../../util/logger.js", () => ({
  ...realLogger,
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ── Mutable mock state ────────────────────────────────────────────────
// `flagEnabled` toggles the `workflows` feature flag; `configThrows`
// simulates config not yet loaded (test-setup race). The run-manager mock
// records the args of the last `start()` call for assertion.

let flagEnabled = true;
let configThrows = false;

const realLoader = await import("../../config/loader.js");
mock.module("../../config/loader.js", () => ({
  ...realLoader,
  getConfig: () => {
    if (configThrows) throw new Error("config not loaded");
    return {} as ReturnType<typeof realLoader.getConfig>;
  },
}));

const realFlags = await import("../../config/assistant-feature-flags.js");
mock.module("../../config/assistant-feature-flags.js", () => ({
  ...realFlags,
  isAssistantFeatureFlagEnabled: (key: string) =>
    key === "workflows" ? flagEnabled : false,
}));

// No live conversation in tests — the tool falls back to a synthetic trust
// context built from the tool context's trustClass.
const realRegistry = await import("../../daemon/conversation-registry.js");
mock.module("../../daemon/conversation-registry.js", () => ({
  ...realRegistry,
  findConversation: () => undefined,
}));

let lastStartArgs: Record<string, unknown> | null = null;
let startThrows: Error | null = null;
const startMock = mock((opts: Record<string, unknown>) => {
  if (startThrows) throw startThrows;
  lastStartArgs = opts;
  return { runId: "run-123" };
});
const statusMock = mock(() => null as unknown);
const abortMock = mock(() => {});
const listMock = mock(() => [] as unknown[]);
let resumeThrows: Error | null = null;
const resumeMock = mock((runId: string) => {
  if (resumeThrows) throw resumeThrows;
  return { runId };
});

mock.module("../../workflows/run-manager.js", () => ({
  getWorkflowRunManager: () => ({
    start: startMock,
    status: statusMock,
    abort: abortMock,
    list: listMock,
    resume: resumeMock,
  }),
}));

// Imports AFTER mocks so the mocked modules are picked up.
const { getWorkflowToolsIfEnabled } = await import("../tool-manifest.js");
const { runWorkflowTool } = await import("./run-workflow.js");
const { manageWorkflowsTool } = await import("./manage-workflows.js");
const { WORKFLOW_READONLY_BASELINE } =
  await import("../../workflows/capabilities.js");

// Minimal tool context — only the fields the workflow tools read.
function makeContext(): Parameters<typeof runWorkflowTool.execute>[1] {
  return {
    conversationId: "conv-1",
    workingDir: "/tmp",
    trustClass: "guardian",
  } as Parameters<typeof runWorkflowTool.execute>[1];
}

beforeEach(() => {
  flagEnabled = true;
  configThrows = false;
  startThrows = null;
  lastStartArgs = null;
  resumeThrows = null;
  startMock.mockClear();
  statusMock.mockClear();
  abortMock.mockClear();
  listMock.mockClear();
  resumeMock.mockClear();
});

describe("workflow tool registration gating", () => {
  test("registers both tools when the workflows flag is enabled", () => {
    flagEnabled = true;
    const names = getWorkflowToolsIfEnabled().map((t) => t.name);
    expect(names).toContain("run_workflow");
    expect(names).toContain("manage_workflows");
  });

  test("registers nothing when the workflows flag is disabled", () => {
    flagEnabled = false;
    expect(getWorkflowToolsIfEnabled()).toEqual([]);
  });

  test("registers nothing when config is not yet loaded", () => {
    configThrows = true;
    expect(getWorkflowToolsIfEnabled()).toEqual([]);
  });
});

describe("run_workflow capability contract", () => {
  test("advertises the actual read-only baseline (no drift from the code)", () => {
    // The description interpolates WORKFLOW_READONLY_BASELINE, so the contract
    // the model reads always matches what resolveCapabilities actually grants.
    // Guards against re-hardcoding a stale list (e.g. re-advertising web_fetch).
    for (const name of WORKFLOW_READONLY_BASELINE) {
      expect(runWorkflowTool.description).toContain(name);
    }
    // web_fetch is side-effecting, so it is NOT a default — the contract must
    // present it as a tool to DECLARE, never as part of the baseline.
    expect(WORKFLOW_READONLY_BASELINE).not.toContain("web_fetch");
  });
});

describe("run_workflow input validation", () => {
  test("rejects when neither script nor name is provided", async () => {
    const res = await runWorkflowTool.execute({}, makeContext());
    expect(res.isError).toBe(true);
    expect(startMock).not.toHaveBeenCalled();
  });

  test("rejects when BOTH script and name are provided", async () => {
    const res = await runWorkflowTool.execute(
      { script: "export const meta = {};", name: "saved" },
      makeContext(),
    );
    expect(res.isError).toBe(true);
    expect(startMock).not.toHaveBeenCalled();
  });
});

describe("run_workflow launch", () => {
  test("starts an inline-script run with the built manifest and returns runId", async () => {
    const res = await runWorkflowTool.execute(
      {
        script: "export const meta = { name: 'x', description: 'y' };",
        args: { foo: 1 },
        capabilities: { tools: ["file_write"], persona: true },
        label: "My Run",
      },
      makeContext(),
    );

    expect(res.isError).toBe(false);
    expect(JSON.parse(res.content).runId).toBe("run-123");

    expect(startMock).toHaveBeenCalledTimes(1);
    expect(lastStartArgs).toMatchObject({
      scriptSource: "export const meta = { name: 'x', description: 'y' };",
      args: { foo: 1 },
      label: "My Run",
      conversationId: "conv-1",
      manifest: { tools: ["file_write"], hostFunctions: [], persona: true },
    });
    // Trust context falls back to the tool context's trust class.
    expect(
      (lastStartArgs as Record<string, unknown>).trustContext,
    ).toMatchObject({
      trustClass: "guardian",
    });
  });

  test("starts a saved-name run and defaults the manifest to empties", async () => {
    await runWorkflowTool.execute({ name: "saved-flow" }, makeContext());
    expect(lastStartArgs).toMatchObject({
      name: "saved-flow",
      manifest: { tools: [], hostFunctions: [], persona: false },
    });
    expect(
      (lastStartArgs as Record<string, unknown>).scriptSource,
    ).toBeUndefined();
  });

  test("surfaces a run-manager start error as a tool error", async () => {
    startThrows = new Error("Workflows are not enabled.");
    const res = await runWorkflowTool.execute(
      { script: "export const meta = {};" },
      makeContext(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Workflows are not enabled.");
  });
});

describe("manage_workflows", () => {
  test("list_runs delegates to list()", async () => {
    listMock.mockReturnValueOnce([
      {
        id: "r1",
        name: "flow",
        status: "completed",
        agentsSpawned: 3,
      },
    ] as unknown[]);
    const res = await manageWorkflowsTool.execute(
      { action: "list_runs" },
      makeContext(),
    );
    expect(res.isError).toBe(false);
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(res.content).runs[0].runId).toBe("r1");
  });

  test("abort requires run_id and delegates to abort()", async () => {
    const missing = await manageWorkflowsTool.execute(
      { action: "abort" },
      makeContext(),
    );
    expect(missing.isError).toBe(true);
    expect(abortMock).not.toHaveBeenCalled();

    // abort now fetches the run first to enforce ownership; seed an owned run.
    statusMock.mockReturnValueOnce({
      id: "r9",
      conversationId: "conv-1",
    } as unknown);
    const ok = await manageWorkflowsTool.execute(
      { action: "abort", run_id: "r9" },
      makeContext(),
    );
    expect(ok.isError).toBe(false);
    expect(abortMock).toHaveBeenCalledWith("r9");
  });

  test("status requires run_id and reports not-found cleanly", async () => {
    const missing = await manageWorkflowsTool.execute(
      { action: "status" },
      makeContext(),
    );
    expect(missing.isError).toBe(true);

    const res = await manageWorkflowsTool.execute(
      { action: "status", run_id: "nope" },
      makeContext(),
    );
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.content).found).toBe(false);
  });

  test("resume requires run_id and delegates to resume()", async () => {
    const missing = await manageWorkflowsTool.execute(
      { action: "resume" },
      makeContext(),
    );
    expect(missing.isError).toBe(true);
    expect(resumeMock).not.toHaveBeenCalled();

    // resume now fetches the run first to enforce ownership; seed an owned run.
    statusMock.mockReturnValueOnce({
      id: "r9",
      conversationId: "conv-1",
    } as unknown);
    const ok = await manageWorkflowsTool.execute(
      { action: "resume", run_id: "r9" },
      makeContext(),
    );
    expect(ok.isError).toBe(false);
    expect(resumeMock).toHaveBeenCalledWith("r9");
    expect(JSON.parse(ok.content).runId).toBe("r9");
  });

  test("resume surfaces a run-manager error as a tool error", async () => {
    statusMock.mockReturnValueOnce({
      id: "r9",
      conversationId: "conv-1",
    } as unknown);
    resumeThrows = new Error(
      "Workflow run r9 is not resumable (status: completed).",
    );
    const res = await manageWorkflowsTool.execute(
      { action: "resume", run_id: "r9" },
      makeContext(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("not resumable");
  });

  test("rejects an unknown action", async () => {
    const res = await manageWorkflowsTool.execute(
      { action: "bogus" },
      makeContext(),
    );
    expect(res.isError).toBe(true);
  });

  // Non-guardian authorization scope: a contact conversation may only see and
  // control runs it originated, never another conversation's (or a guardian's).
  const contactContext = () =>
    ({
      conversationId: "conv-1",
      workingDir: "/tmp",
      trustClass: "trusted_contact",
    }) as Parameters<typeof manageWorkflowsTool.execute>[1];

  test("list_runs is scoped to the caller's conversation for a non-guardian", async () => {
    listMock.mockReturnValueOnce([
      { id: "mine", name: "a", status: "running", conversationId: "conv-1" },
      { id: "theirs", name: "b", status: "running", conversationId: "conv-2" },
      { id: "nullconv", name: "c", status: "running", conversationId: null },
    ] as unknown[]);
    const res = await manageWorkflowsTool.execute(
      { action: "list_runs" },
      contactContext(),
    );
    const ids = JSON.parse(res.content).runs.map(
      (r: { runId: string }) => r.runId,
    );
    expect(ids).toEqual(["mine"]);
  });

  test("a non-guardian cannot status/abort/resume another conversation's run", async () => {
    const foreign = {
      id: "theirs",
      name: "b",
      status: "interrupted",
      conversationId: "conv-2",
    } as unknown;

    statusMock.mockReturnValueOnce(foreign);
    const status = await manageWorkflowsTool.execute(
      { action: "status", run_id: "theirs" },
      contactContext(),
    );
    // Reads as not-found — never reveals the foreign run's details.
    expect(JSON.parse(status.content).found).toBe(false);

    statusMock.mockReturnValueOnce(foreign);
    await manageWorkflowsTool.execute(
      { action: "abort", run_id: "theirs" },
      contactContext(),
    );
    expect(abortMock).not.toHaveBeenCalled();

    statusMock.mockReturnValueOnce(foreign);
    const resume = await manageWorkflowsTool.execute(
      { action: "resume", run_id: "theirs" },
      contactContext(),
    );
    expect(resume.isError).toBe(true);
    expect(resume.content).toContain("not found");
    expect(resumeMock).not.toHaveBeenCalled();
  });

  test("a non-guardian CAN control a run it originated", async () => {
    statusMock.mockReturnValueOnce({
      id: "mine",
      conversationId: "conv-1",
    } as unknown);
    await manageWorkflowsTool.execute(
      { action: "abort", run_id: "mine" },
      contactContext(),
    );
    expect(abortMock).toHaveBeenCalledWith("mine");
  });
});
