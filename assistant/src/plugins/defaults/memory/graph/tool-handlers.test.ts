import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantConfig } from "../../../../config/types.js";
import type { MemoryNode } from "./types.js";

// ── Store mocks (must be declared before importing the module under test) ───

const queryNodesMock = mock<() => MemoryNode[]>(() => []);
const deleteNodeMock = mock<(id: string) => void>(() => {});
const updateNodeMock = mock<(id: string, changes: Partial<MemoryNode>) => void>(
  () => {},
);
const recordNodeEditMock = mock(() => {});

mock.module("./store.js", () => ({
  queryNodes: queryNodesMock,
  deleteNode: deleteNodeMock,
  updateNode: updateNodeMock,
  recordNodeEdit: recordNodeEditMock,
}));

// Other deps used by the remember and update paths
mock.module("../jobs/embed-pkb-file.js", () => ({
  enqueuePkbIndexJob: mock(() => {}),
}));

const enqueueMemoryJobMock = mock(() => {});
mock.module("../../../../persistence/jobs-store.js", () => ({
  enqueueMemoryJob: enqueueMemoryJobMock,
}));

import { handleDeleteMemory, handleUpdateMemory } from "./tool-handlers.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(v2Enabled = true): AssistantConfig {
  return { memory: { v2: { enabled: v2Enabled } } } as AssistantConfig;
}

function makeNode(id: string, content: string): MemoryNode {
  const now = Date.now();
  return {
    id,
    content,
    fidelity: "vivid",
    type: "semantic",
    created: now,
    lastAccessed: now,
    lastConsolidated: now,
    eventDate: null,
    emotionalCharge: {
      valence: 0,
      intensity: 0,
      decayCurve: "linear",
      decayRate: 0.1,
      originalIntensity: 0,
    },
    confidence: 1,
    significance: 0.5,
    stability: 1,
    reinforcementCount: 0,
    lastReinforced: now,
    sourceConversations: [],
    sourceType: "direct",
    narrativeRole: null,
    partOfStory: null,
    imageRefs: null,
    scopeId: "default",
  };
}

beforeEach(() => {
  queryNodesMock.mockClear();
  deleteNodeMock.mockClear();
  updateNodeMock.mockClear();
  recordNodeEditMock.mockClear();
  queryNodesMock.mockReturnValue([]);
});

// ── handleDeleteMemory ────────────────────────────────────────────────────────

describe("handleDeleteMemory — input validation", () => {
  test("returns error when content is empty", () => {
    const result = handleDeleteMemory({ content: "" }, makeConfig());
    expect(result.success).toBe(false);
    expect(result.message).toContain("content is required");
    expect(deleteNodeMock).not.toHaveBeenCalled();
  });

  test("returns error when content is whitespace only", () => {
    const result = handleDeleteMemory({ content: "   " }, makeConfig());
    expect(result.success).toBe(false);
    expect(deleteNodeMock).not.toHaveBeenCalled();
  });

  test("returns error when memory v2 is disabled", () => {
    const result = handleDeleteMemory(
      { content: "something" },
      makeConfig(false),
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("memory v2");
    expect(queryNodesMock).not.toHaveBeenCalled();
  });
});

describe("handleDeleteMemory — matching", () => {
  test("returns error when no node matches", () => {
    queryNodesMock.mockReturnValue([makeNode("n1", "I live in Nairobi")]);
    const result = handleDeleteMemory(
      { content: "I live in Kigali" },
      makeConfig(),
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("No memory found");
    expect(deleteNodeMock).not.toHaveBeenCalled();
  });

  test("deletes node on exact match (case-insensitive)", () => {
    queryNodesMock.mockReturnValue([makeNode("n1", "I live in Kigali")]);
    const result = handleDeleteMemory(
      { content: "i live in kigali" },
      makeConfig(),
    );
    expect(result.success).toBe(true);
    expect(deleteNodeMock).toHaveBeenCalledTimes(1);
    expect(deleteNodeMock).toHaveBeenCalledWith("n1");
  });

  test("deletes node on substring match when no exact match exists", () => {
    queryNodesMock.mockReturnValue([
      makeNode("n1", "manzi lives in Kigali, Rwanda"),
    ]);
    const result = handleDeleteMemory({ content: "Kigali" }, makeConfig());
    expect(result.success).toBe(true);
    expect(deleteNodeMock).toHaveBeenCalledWith("n1");
  });

  test("returns error when multiple nodes match and lists candidates", () => {
    queryNodesMock.mockReturnValue([
      makeNode("n1", "manzi prefers TypeScript"),
      makeNode("n2", "manzi prefers dark mode"),
    ]);
    const result = handleDeleteMemory(
      { content: "manzi prefers" },
      makeConfig(),
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("Multiple memories match");
    expect(result.message).toContain("manzi prefers TypeScript");
    expect(result.message).toContain("manzi prefers dark mode");
    expect(deleteNodeMock).not.toHaveBeenCalled();
  });

  test("prefers exact match over partial match when both exist", () => {
    queryNodesMock.mockReturnValue([
      makeNode("n1", "I live in Kigali"),
      makeNode("n2", "I live in Kigali and work from home"),
    ]);
    const result = handleDeleteMemory(
      { content: "I live in Kigali" },
      makeConfig(),
    );
    // Exact match wins — only n1 is an exact match
    expect(result.success).toBe(true);
    expect(deleteNodeMock).toHaveBeenCalledWith("n1");
  });
});

// ── handleUpdateMemory ────────────────────────────────────────────────────────

describe("handleUpdateMemory — input validation", () => {
  test("returns error when old_content is empty", () => {
    const result = handleUpdateMemory(
      { old_content: "", new_content: "new fact" },
      "conv-1",
      makeConfig(),
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("required");
    expect(updateNodeMock).not.toHaveBeenCalled();
  });

  test("returns error when new_content is empty", () => {
    const result = handleUpdateMemory(
      { old_content: "old fact", new_content: "   " },
      "conv-1",
      makeConfig(),
    );
    expect(result.success).toBe(false);
    expect(updateNodeMock).not.toHaveBeenCalled();
  });

  test("returns error when memory v2 is disabled", () => {
    const result = handleUpdateMemory(
      { old_content: "old", new_content: "new" },
      "conv-1",
      makeConfig(false),
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("memory v2");
    expect(queryNodesMock).not.toHaveBeenCalled();
  });
});

describe("handleUpdateMemory — matching and update", () => {
  test("returns error when no node matches old_content", () => {
    queryNodesMock.mockReturnValue([makeNode("n1", "I live in Nairobi")]);
    const result = handleUpdateMemory(
      { old_content: "I live in Kigali", new_content: "I live in Nairobi" },
      "conv-1",
      makeConfig(),
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("No memory found");
    expect(updateNodeMock).not.toHaveBeenCalled();
  });

  test("updates node content and records edit history on exact match", () => {
    const node = makeNode("n1", "I live in Kigali");
    queryNodesMock.mockReturnValue([node]);
    const result = handleUpdateMemory(
      { old_content: "I live in Kigali", new_content: "I live in Nairobi" },
      "conv-42",
      makeConfig(),
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain("I live in Kigali");
    expect(result.message).toContain("I live in Nairobi");

    expect(recordNodeEditMock).toHaveBeenCalledTimes(1);
    expect(recordNodeEditMock).toHaveBeenCalledWith({
      nodeId: "n1",
      previousContent: "I live in Kigali",
      newContent: "I live in Nairobi",
      source: "manual",
      conversationId: "conv-42",
    });

    expect(updateNodeMock).toHaveBeenCalledTimes(1);
    expect(updateNodeMock).toHaveBeenCalledWith("n1", {
      content: "I live in Nairobi",
    });
  });

  test("updates via substring match when no exact match", () => {
    const node = makeNode("n1", "manzi lives in Kigali, Rwanda");
    queryNodesMock.mockReturnValue([node]);
    const result = handleUpdateMemory(
      { old_content: "Kigali", new_content: "manzi lives in Nairobi, Rwanda" },
      "conv-1",
      makeConfig(),
    );
    expect(result.success).toBe(true);
    expect(updateNodeMock).toHaveBeenCalledWith("n1", {
      content: "manzi lives in Nairobi, Rwanda",
    });
  });

  test("returns error when multiple nodes match old_content", () => {
    queryNodesMock.mockReturnValue([
      makeNode("n1", "manzi prefers TypeScript"),
      makeNode("n2", "manzi prefers dark mode"),
    ]);
    const result = handleUpdateMemory(
      {
        old_content: "manzi prefers",
        new_content: "manzi prefers Rust",
      },
      "conv-1",
      makeConfig(),
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("Multiple memories match");
    expect(updateNodeMock).not.toHaveBeenCalled();
    expect(recordNodeEditMock).not.toHaveBeenCalled();
  });

  test("recordNodeEdit is called before updateNode (edit history first)", () => {
    const callOrder: string[] = [];
    recordNodeEditMock.mockImplementation(() => {
      callOrder.push("recordNodeEdit");
    });
    updateNodeMock.mockImplementation(() => {
      callOrder.push("updateNode");
    });

    queryNodesMock.mockReturnValue([makeNode("n1", "old content")]);
    handleUpdateMemory(
      { old_content: "old content", new_content: "new content" },
      "conv-1",
      makeConfig(),
    );

    expect(callOrder).toEqual(["recordNodeEdit", "updateNode"]);
  });
});
