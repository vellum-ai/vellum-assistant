import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { ROUTES } from "../runtime/routes/background-tool-routes.js";
import { BadRequestError } from "../runtime/routes/errors.js";
import type { RouteDefinition } from "../runtime/routes/types.js";
import {
  _clearRegistryForTesting,
  recordCompletedBackgroundTool,
  registerBackgroundTool,
} from "../tools/background-tool-registry.js";

// ── Helpers ───────────────────────────────────────────────────────────

function findRoute(operationId: string): RouteDefinition | undefined {
  return ROUTES.find((r) => r.operationId === operationId);
}

function makeTool(overrides: {
  id: string;
  toolName?: string;
  conversationId?: string;
  command?: string;
  startedAt?: number;
}) {
  return {
    id: overrides.id,
    toolName: overrides.toolName ?? "bash",
    conversationId: overrides.conversationId ?? "conv-1",
    command: overrides.command ?? "sleep 10",
    startedAt: overrides.startedAt ?? Date.now(),
    cancel: mock(() => {}),
  };
}

// ── Setup / Teardown ──────────────────────────────────────────────────

beforeEach(() => {
  _clearRegistryForTesting();
});

afterEach(() => {
  _clearRegistryForTesting();
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("background tool routes", () => {
  describe("GET /v1/background-tools (list)", () => {
    test("returns empty arrays when no tools are registered", async () => {
      const route = findRoute("background_tool_list")!;
      const result = (await route.handler({})) as {
        tools: unknown[];
        completed: unknown[];
      };

      expect(result.tools).toEqual([]);
      expect(result.completed).toEqual([]);
    });

    test("returns recently-completed tools with terminal fields", async () => {
      recordCompletedBackgroundTool({
        id: "bg-done-1",
        toolName: "bash",
        conversationId: "conv-1",
        command: "npm run build",
        startedAt: 1700000000000,
        status: "completed",
        exitCode: 0,
        output: "built",
        completedAt: 1700000004200,
      });

      const route = findRoute("background_tool_list")!;
      const result = (await route.handler({})) as {
        tools: unknown[];
        completed: Array<{
          id: string;
          status: string;
          exitCode: number | null;
          output: string;
          completedAt: number;
        }>;
      };

      expect(result.tools).toEqual([]);
      expect(result.completed).toHaveLength(1);
      expect(result.completed[0]).toMatchObject({
        id: "bg-done-1",
        status: "completed",
        exitCode: 0,
        output: "built",
        completedAt: 1700000004200,
      });
    });

    test("filters completed tools by conversationId", async () => {
      recordCompletedBackgroundTool({
        id: "bg-d1",
        toolName: "bash",
        conversationId: "conv-a",
        command: "x",
        startedAt: 1,
        status: "completed",
        exitCode: 0,
        output: "",
        completedAt: 2,
      });
      recordCompletedBackgroundTool({
        id: "bg-d2",
        toolName: "bash",
        conversationId: "conv-b",
        command: "x",
        startedAt: 1,
        status: "failed",
        exitCode: 1,
        output: "",
        completedAt: 2,
      });

      const route = findRoute("background_tool_list")!;
      const result = (await route.handler({
        queryParams: { conversationId: "conv-a" },
      })) as { completed: Array<{ id: string }> };

      expect(result.completed.map((t) => t.id)).toEqual(["bg-d1"]);
    });

    test("returns registered tools with toolName field", async () => {
      const tool = makeTool({
        id: "bg-abc123",
        toolName: "host_bash",
        conversationId: "conv-1",
        command: "npm test",
        startedAt: 1700000000000,
      });
      registerBackgroundTool(tool);

      const route = findRoute("background_tool_list")!;
      const result = (await route.handler({})) as {
        tools: Array<{
          id: string;
          toolName: string;
          conversationId: string;
          command: string;
          startedAt: number;
        }>;
      };

      expect(result.tools).toHaveLength(1);
      expect(result.tools[0]!.id).toBe("bg-abc123");
      expect(result.tools[0]!.toolName).toBe("host_bash");
      expect(result.tools[0]!.conversationId).toBe("conv-1");
      expect(result.tools[0]!.command).toBe("npm test");
      expect(result.tools[0]!.startedAt).toBe(1700000000000);
    });

    test("does not include the cancel function in the response", async () => {
      registerBackgroundTool(makeTool({ id: "bg-1" }));

      const route = findRoute("background_tool_list")!;
      const result = (await route.handler({})) as {
        tools: Array<Record<string, unknown>>;
      };

      expect(result.tools[0]).not.toHaveProperty("cancel");
    });

    test("filters by conversationId", async () => {
      registerBackgroundTool(
        makeTool({ id: "bg-1", conversationId: "conv-a" }),
      );
      registerBackgroundTool(
        makeTool({ id: "bg-2", conversationId: "conv-b" }),
      );
      registerBackgroundTool(
        makeTool({ id: "bg-3", conversationId: "conv-a" }),
      );

      const route = findRoute("background_tool_list")!;
      const result = (await route.handler({
        queryParams: { conversationId: "conv-a" },
      })) as {
        tools: Array<{ id: string }>;
      };

      expect(result.tools).toHaveLength(2);
      expect(result.tools.map((t) => t.id).sort()).toEqual(["bg-1", "bg-3"]);
    });

    test("returns all tools when conversationId is not provided", async () => {
      registerBackgroundTool(
        makeTool({ id: "bg-1", conversationId: "conv-a" }),
      );
      registerBackgroundTool(
        makeTool({ id: "bg-2", conversationId: "conv-b" }),
      );

      const route = findRoute("background_tool_list")!;
      const result = (await route.handler({})) as {
        tools: Array<{ id: string }>;
      };

      expect(result.tools).toHaveLength(2);
    });
  });

  describe("POST /v1/background-tools/cancel", () => {
    test("cancels a registered tool and returns cancelled: true", async () => {
      const tool = makeTool({ id: "bg-cancel-me" });
      registerBackgroundTool(tool);

      const route = findRoute("background_tool_cancel")!;
      const result = (await route.handler({
        body: { id: "bg-cancel-me" },
      })) as {
        cancelled: boolean;
      };

      expect(result.cancelled).toBe(true);
      expect(tool.cancel).toHaveBeenCalled();
    });

    test("returns cancelled: false for unknown ID", async () => {
      const route = findRoute("background_tool_cancel")!;
      const result = (await route.handler({
        body: { id: "bg-nonexistent" },
      })) as {
        cancelled: boolean;
      };

      expect(result.cancelled).toBe(false);
    });

    test("throws BadRequestError when id is not provided", async () => {
      const route = findRoute("background_tool_cancel")!;
      await expect(route.handler({ body: {} })).rejects.toThrow(
        BadRequestError,
      );
    });

    test("throws BadRequestError when body is empty", async () => {
      const route = findRoute("background_tool_cancel")!;
      await expect(route.handler({})).rejects.toThrow(BadRequestError);
    });
  });
});
