import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  _clearRegistryForTesting,
  type BackgroundTool,
  cancelBackgroundTool,
  type CompletedBackgroundTool,
  generateBackgroundToolId,
  listBackgroundTools,
  listCompletedBackgroundTools,
  MAX_BACKGROUND_TOOLS,
  MAX_COMPLETED_BACKGROUND_TOOLS,
  recordCompletedBackgroundTool,
  registerBackgroundTool,
  removeBackgroundTool,
} from "../tools/background-tool-registry.js";

function makeTool(overrides: Partial<BackgroundTool> = {}): BackgroundTool {
  return {
    id: overrides.id ?? generateBackgroundToolId(),
    toolName: overrides.toolName ?? "bash",
    conversationId: overrides.conversationId ?? "conv-xyz",
    command: overrides.command ?? "echo hello",
    startedAt: overrides.startedAt ?? Date.now(),
    cancel: overrides.cancel ?? mock(() => {}),
  };
}

describe("background-tool-registry", () => {
  beforeEach(() => {
    _clearRegistryForTesting();
  });

  describe("register / list / remove lifecycle", () => {
    test("registers a tool and lists it", () => {
      const tool = makeTool({ id: "bg-00000001" });
      registerBackgroundTool(tool);

      const listed = listBackgroundTools();
      expect(listed).toHaveLength(1);
      expect(listed[0]!.id).toBe("bg-00000001");
    });

    test("removes a tool by ID", () => {
      const tool = makeTool({ id: "bg-00000002" });
      registerBackgroundTool(tool);
      expect(listBackgroundTools()).toHaveLength(1);

      removeBackgroundTool("bg-00000002");
      expect(listBackgroundTools()).toHaveLength(0);
    });

    test("removing a non-existent ID is a no-op", () => {
      registerBackgroundTool(makeTool({ id: "bg-00000003" }));
      removeBackgroundTool("bg-nonexistent");
      expect(listBackgroundTools()).toHaveLength(1);
    });
  });

  describe("cancelBackgroundTool", () => {
    test("calls cancel(), removes the entry, and returns true", () => {
      const cancelFn = mock(() => {});
      const tool = makeTool({ id: "bg-cancel-1", cancel: cancelFn });
      registerBackgroundTool(tool);

      const result = cancelBackgroundTool("bg-cancel-1");

      expect(result).toBe(true);
      expect(cancelFn).toHaveBeenCalledTimes(1);
      expect(listBackgroundTools()).toHaveLength(0);
    });

    test("returns false for unknown IDs", () => {
      const result = cancelBackgroundTool("bg-unknown");
      expect(result).toBe(false);
    });
  });

  describe("listBackgroundTools filtering", () => {
    test("returns all tools when no conversationId is provided", () => {
      registerBackgroundTool(
        makeTool({ id: "bg-a1", conversationId: "conv-1" }),
      );
      registerBackgroundTool(
        makeTool({ id: "bg-a2", conversationId: "conv-2" }),
      );

      expect(listBackgroundTools()).toHaveLength(2);
    });

    test("filters by conversationId when provided", () => {
      registerBackgroundTool(
        makeTool({ id: "bg-b1", conversationId: "conv-1" }),
      );
      registerBackgroundTool(
        makeTool({ id: "bg-b2", conversationId: "conv-2" }),
      );
      registerBackgroundTool(
        makeTool({ id: "bg-b3", conversationId: "conv-1" }),
      );

      const filtered = listBackgroundTools("conv-1");
      expect(filtered).toHaveLength(2);
      expect(filtered.map((t) => t.id).sort()).toEqual(["bg-b1", "bg-b3"]);

      expect(listBackgroundTools("conv-2")).toHaveLength(1);
      expect(listBackgroundTools("conv-nonexistent")).toHaveLength(0);
    });
  });

  describe("MAX_BACKGROUND_TOOLS limit", () => {
    test("throws when limit is exceeded", () => {
      for (let i = 0; i < MAX_BACKGROUND_TOOLS; i++) {
        registerBackgroundTool(makeTool({ id: `bg-lim-${i}` }));
      }

      expect(() =>
        registerBackgroundTool(makeTool({ id: "bg-overflow" })),
      ).toThrow(/Background tool limit reached/);
      expect(listBackgroundTools()).toHaveLength(MAX_BACKGROUND_TOOLS);
    });

    test("allows registration after removing one at the limit", () => {
      for (let i = 0; i < MAX_BACKGROUND_TOOLS; i++) {
        registerBackgroundTool(makeTool({ id: `bg-cap-${i}` }));
      }

      removeBackgroundTool("bg-cap-0");
      expect(() =>
        registerBackgroundTool(makeTool({ id: "bg-cap-new" })),
      ).not.toThrow();
      expect(listBackgroundTools()).toHaveLength(MAX_BACKGROUND_TOOLS);
    });
  });

  describe("completed ring (recordCompletedBackgroundTool)", () => {
    function makeCompletion(
      overrides: Partial<CompletedBackgroundTool> = {},
    ): CompletedBackgroundTool {
      return {
        id: overrides.id ?? "bg-done-1",
        toolName: overrides.toolName ?? "bash",
        conversationId: overrides.conversationId ?? "conv-1",
        command: overrides.command ?? "echo hi",
        startedAt: overrides.startedAt ?? 1,
        status: overrides.status ?? "completed",
        exitCode: overrides.exitCode ?? 0,
        output: overrides.output ?? "hi",
        completedAt: overrides.completedAt ?? 2,
      };
    }

    test("records a completed tool and lists it with terminal fields", () => {
      recordCompletedBackgroundTool(
        makeCompletion({ id: "bg-c1", status: "failed", exitCode: 1 }),
      );

      const listed = listCompletedBackgroundTools();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        id: "bg-c1",
        status: "failed",
        exitCode: 1,
        output: "hi",
      });
    });

    test("filters completed tools by conversationId", () => {
      recordCompletedBackgroundTool(
        makeCompletion({ id: "bg-c1", conversationId: "conv-1" }),
      );
      recordCompletedBackgroundTool(
        makeCompletion({ id: "bg-c2", conversationId: "conv-2" }),
      );

      expect(listCompletedBackgroundTools("conv-1").map((t) => t.id)).toEqual([
        "bg-c1",
      ]);
      expect(listCompletedBackgroundTools("conv-9")).toHaveLength(0);
    });

    test("re-recording the same id replaces rather than duplicates", () => {
      recordCompletedBackgroundTool(
        makeCompletion({ id: "bg-c1", status: "completed" }),
      );
      recordCompletedBackgroundTool(
        makeCompletion({ id: "bg-c1", status: "cancelled" }),
      );

      const listed = listCompletedBackgroundTools();
      expect(listed).toHaveLength(1);
      expect(listed[0]!.status).toBe("cancelled");
    });

    test("evicts the oldest beyond MAX_COMPLETED_BACKGROUND_TOOLS", () => {
      for (let i = 0; i < MAX_COMPLETED_BACKGROUND_TOOLS + 5; i++) {
        recordCompletedBackgroundTool(makeCompletion({ id: `bg-r${i}` }));
      }

      const listed = listCompletedBackgroundTools();
      expect(listed).toHaveLength(MAX_COMPLETED_BACKGROUND_TOOLS);
      // Oldest five evicted; newest retained.
      expect(listed.some((t) => t.id === "bg-r0")).toBe(false);
      expect(listed.some((t) => t.id === "bg-r5")).toBe(true);
      expect(
        listed.some(
          (t) => t.id === `bg-r${MAX_COMPLETED_BACKGROUND_TOOLS + 4}`,
        ),
      ).toBe(true);
    });

    test("recording a completion does not touch the active registry", () => {
      registerBackgroundTool(makeTool({ id: "bg-active" }));
      recordCompletedBackgroundTool(makeCompletion({ id: "bg-done" }));

      expect(listBackgroundTools().map((t) => t.id)).toEqual(["bg-active"]);
      expect(listCompletedBackgroundTools().map((t) => t.id)).toEqual([
        "bg-done",
      ]);
    });

    test("_clearRegistryForTesting clears the completed ring", () => {
      recordCompletedBackgroundTool(makeCompletion({ id: "bg-c1" }));
      _clearRegistryForTesting();
      expect(listCompletedBackgroundTools()).toHaveLength(0);
    });
  });

  describe("generateBackgroundToolId", () => {
    test("returns a bg- prefixed string", () => {
      const id = generateBackgroundToolId();
      expect(id).toMatch(/^bg-[a-f0-9]{8}$/);
    });

    test("generates unique IDs", () => {
      const ids = new Set(
        Array.from({ length: 50 }, () => generateBackgroundToolId()),
      );
      expect(ids.size).toBe(50);
    });
  });
});
