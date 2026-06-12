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

mock.module("../../workflows/run-manager.js", () => ({
  getWorkflowRunManager: () => ({
    start: startMock,
    status: statusMock,
    abort: abortMock,
    list: listMock,
  }),
}));

// Imports AFTER mocks so the mocked modules are picked up.
const { getWorkflowToolsIfEnabled } = await import("../tool-manifest.js");
const { runWorkflowTool } = await import("./run-workflow.js");
const { manageWorkflowsTool } = await import("./manage-workflows.js");

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
  startMock.mockClear();
  statusMock.mockClear();
  abortMock.mockClear();
  listMock.mockClear();
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
    expect((lastStartArgs as Record<string, unknown>).trustContext).toMatchObject({
      trustClass: "guardian",
    });
  });

  test("starts a saved-name run and defaults the manifest to empties", async () => {
    await runWorkflowTool.execute({ name: "saved-flow" }, makeContext());
    expect(lastStartArgs).toMatchObject({
      name: "saved-flow",
      manifest: { tools: [], hostFunctions: [], persona: false },
    });
    expect((lastStartArgs as Record<string, unknown>).scriptSource).toBeUndefined();
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

  test("rejects an unknown action", async () => {
    const res = await manageWorkflowsTool.execute(
      { action: "bogus" },
      makeContext(),
    );
    expect(res.isError).toBe(true);
  });
});
