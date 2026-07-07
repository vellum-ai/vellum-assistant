/**
 * Unit tests for handleDeleteMemory, handleUpdateMemory, handleListMemory.
 *
 * All DB/store calls are mocked so the tests run without a real workspace.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Stub logger ────────────────────────────────────────────────────────────────
mock.module("../../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// ── Controllable store mock ────────────────────────────────────────────────────
let mockNodes: Array<{
  id: string;
  content: string;
  type: string;
  fidelity: string;
  created: number;
}> = [];

const mockDeleteNode = mock(() => {});
const mockUpdateNode = mock(() => {});
const mockRecordNodeEdit = mock(() => {});

mock.module("./store.js", () => ({
  queryNodes: () => mockNodes,
  deleteNode: mockDeleteNode,
  updateNode: mockUpdateNode,
  recordNodeEdit: mockRecordNodeEdit,
}));

// ── Stub jobs-store ────────────────────────────────────────────────────────────
const mockEnqueueMemoryJob = mock(() => {});

mock.module("../../../../persistence/jobs-store.js", () => ({
  enqueueMemoryJob: mockEnqueueMemoryJob,
}));

// ── Stub fs / platform (used by remember handler, not our handlers) ────────────
mock.module("node:fs", () => ({
  appendFileSync: () => {},
  existsSync: () => false,
  mkdirSync: () => {},
}));

mock.module("../../../../util/platform.js", () => ({
  getWorkspaceDir: () => "/tmp/test-workspace",
}));

mock.module("../jobs/embed-pkb-file.js", () => ({
  enqueuePkbIndexJob: () => {},
}));

mock.module("../pkb/types.js", () => ({
  PKB_WORKSPACE_SCOPE: "workspace",
}));

// ── Import handlers after mocks are set up ─────────────────────────────────────
import type { AssistantConfig } from "../../../../config/types.js";
import {
  handleDeleteMemory,
  handleListMemory,
  handleUpdateMemory,
} from "./tool-handlers.js";

// ── Config helpers ─────────────────────────────────────────────────────────────
const configV2On = {
  memory: { v2: { enabled: true } },
} as unknown as AssistantConfig;

const configV2Off = {
  memory: { v2: { enabled: false } },
} as unknown as AssistantConfig;

function node(
  id: string,
  content: string,
  overrides: Partial<(typeof mockNodes)[0]> = {},
) {
  return {
    id,
    content,
    type: "semantic",
    fidelity: "vivid",
    created: Date.now(),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("handleDeleteMemory", () => {
  beforeEach(() => {
    mockNodes = [];
    mockDeleteNode.mockClear();
  });

  test("returns error when content is empty", () => {
    const result = handleDeleteMemory({ content: "  " }, configV2On);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/required/);
  });

  test("returns error when memory v2 is disabled", () => {
    const result = handleDeleteMemory({ content: "foo" }, configV2Off);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/memory v2/);
  });

  test("returns error when no node matches", () => {
    mockNodes = [node("1", "Something else entirely")];
    const result = handleDeleteMemory({ content: "TypeScript" }, configV2On);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/No memory found/);
  });

  test("deletes exact-match node", () => {
    mockNodes = [node("1", "User prefers TypeScript")];
    const result = handleDeleteMemory(
      { content: "User prefers TypeScript" },
      configV2On,
    );
    expect(result.success).toBe(true);
    expect(mockDeleteNode).toHaveBeenCalledWith("1");
    expect(result.message).toMatch(/Deleted/);
  });

  test("exact match takes priority over substring match", () => {
    mockNodes = [
      node("1", "User prefers TypeScript"),
      node("2", "User prefers TypeScript over JavaScript"),
    ];
    const result = handleDeleteMemory(
      { content: "User prefers TypeScript" },
      configV2On,
    );
    expect(result.success).toBe(true);
    expect(mockDeleteNode).toHaveBeenCalledWith("1");
  });

  test("returns error when multiple nodes match", () => {
    mockNodes = [
      node("1", "User likes TypeScript"),
      node("2", "User uses TypeScript at work"),
    ];
    const result = handleDeleteMemory({ content: "TypeScript" }, configV2On);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Multiple memories match/);
    expect(mockDeleteNode).not.toHaveBeenCalled();
  });
});

describe("handleUpdateMemory", () => {
  beforeEach(() => {
    mockNodes = [];
    mockUpdateNode.mockClear();
    mockRecordNodeEdit.mockClear();
    mockEnqueueMemoryJob.mockClear();
  });

  test("returns error when inputs are missing", () => {
    const result = handleUpdateMemory(
      { old_content: "", new_content: "new" },
      "cli",
      configV2On,
    );
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/required/);
  });

  test("returns error when memory v2 is disabled", () => {
    const result = handleUpdateMemory(
      { old_content: "old", new_content: "new" },
      "cli",
      configV2Off,
    );
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/memory v2/);
  });

  test("returns error when no node matches old_content", () => {
    mockNodes = [node("1", "Something else")];
    const result = handleUpdateMemory(
      { old_content: "TypeScript", new_content: "JavaScript" },
      "cli",
      configV2On,
    );
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/No memory found/);
  });

  test("updates matching node and re-embeds", () => {
    mockNodes = [node("1", "User prefers TypeScript")];
    const result = handleUpdateMemory(
      {
        old_content: "User prefers TypeScript",
        new_content: "User prefers TypeScript and Bun",
      },
      "cli",
      configV2On,
    );
    expect(result.success).toBe(true);
    expect(mockRecordNodeEdit).toHaveBeenCalledTimes(1);
    expect(mockUpdateNode).toHaveBeenCalledWith("1", {
      content: "User prefers TypeScript and Bun",
    });
    expect(mockEnqueueMemoryJob).toHaveBeenCalledWith("embed_graph_node", {
      nodeId: "1",
    });
  });

  test("returns error when multiple nodes match", () => {
    mockNodes = [
      node("1", "User likes TypeScript"),
      node("2", "User uses TypeScript daily"),
    ];
    const result = handleUpdateMemory(
      { old_content: "TypeScript", new_content: "Rust" },
      "cli",
      configV2On,
    );
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Multiple memories match/);
    expect(mockUpdateNode).not.toHaveBeenCalled();
  });
});

describe("handleListMemory", () => {
  beforeEach(() => {
    mockNodes = [];
  });

  test("returns empty when memory v2 is disabled", () => {
    const result = handleListMemory({}, configV2Off);
    expect(result.success).toBe(false);
    expect(result.nodes).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  test("returns all active nodes", () => {
    mockNodes = [
      node("1", "User prefers TypeScript"),
      node("2", "User works at Acme Corp"),
    ];
    const result = handleListMemory({}, configV2On);
    expect(result.success).toBe(true);
    expect(result.nodes).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.nodes[0]!.id).toBe("1");
  });

  test("filters by search substring (case-insensitive)", () => {
    mockNodes = [
      node("1", "User prefers TypeScript"),
      node("2", "User works at Acme Corp"),
      node("3", "The sky is typescript-blue"),
    ];
    const result = handleListMemory({ search: "typescript" }, configV2On);
    expect(result.success).toBe(true);
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.map((n) => n.id)).toEqual(["1", "3"]);
  });

  test("returns no results when search matches nothing", () => {
    mockNodes = [node("1", "User prefers TypeScript")];
    const result = handleListMemory({ search: "Python" }, configV2On);
    expect(result.success).toBe(true);
    expect(result.nodes).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  test("respects limit", () => {
    mockNodes = Array.from({ length: 10 }, (_, i) =>
      node(String(i), `Memory ${i}`),
    );
    const result = handleListMemory({ limit: 3 }, configV2On);
    expect(result.nodes).toHaveLength(3);
    expect(result.total).toBe(3);
  });

  test("includes required fields on each node", () => {
    mockNodes = [
      node("42", "Test content", { type: "episodic", fidelity: "clear" }),
    ];
    const result = handleListMemory({}, configV2On);
    const n = result.nodes[0]!;
    expect(n.id).toBe("42");
    expect(n.content).toBe("Test content");
    expect(n.type).toBe("episodic");
    expect(n.fidelity).toBe("clear");
    expect(typeof n.created).toBe("number");
  });
});
