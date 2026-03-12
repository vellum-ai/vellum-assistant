import { describe, expect, test } from "bun:test";

import {
  allComputerUseTools,
  computerUseClickTool,
  computerUseDoneTool,
  computerUseDragTool,
  computerUseKeyTool,
  computerUseOpenAppTool,
  computerUseRespondTool,
  computerUseRunAppleScriptTool,
  computerUseScrollTool,
  computerUseTypeTextTool,
  computerUseWaitTool,
} from "../tools/computer-use/definitions.js";
import { forwardComputerUseProxyTool } from "../tools/computer-use/skill-proxy-bridge.js";
import type { ToolContext } from "../tools/types.js";

interface JsonSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, unknown>;
}

/** Cast a tool definition's input_schema to a usable JSON Schema shape. */
function schema(tool: {
  getDefinition(): { input_schema: object };
}): JsonSchema {
  return tool.getDefinition().input_schema as JsonSchema;
}

const ctx: ToolContext = {
  workingDir: "/tmp",
  sessionId: "test-session",
  conversationId: "test-conversation",
  trustClass: "guardian",
};

// ── Tool definitions ────────────────────────────────────────────────

describe("computer-use tool definitions", () => {
  test("allComputerUseTools contains 11 tools", () => {
    expect(allComputerUseTools.length).toBe(11);
  });

  test("all tools have proxy execution mode", () => {
    for (const tool of allComputerUseTools) {
      expect(tool.executionMode).toBe("proxy");
    }
  });

  test("all tools belong to computer-use category", () => {
    for (const tool of allComputerUseTools) {
      expect(tool.category).toBe("computer-use");
    }
  });

  test("all tools have unique names", () => {
    const names = allComputerUseTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("all tools have descriptions", () => {
    for (const tool of allComputerUseTools) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});

// ── Unified click tool ──────────────────────────────────────────────

describe("computer_use_click (unified)", () => {
  test("has correct name", () => {
    expect(computerUseClickTool.name).toBe("computer_use_click");
  });

  test("schema requires reasoning", () => {
    expect(schema(computerUseClickTool).required).toContain("reasoning");
  });

  test("schema supports click_type enum", () => {
    const props = schema(computerUseClickTool).properties as Record<
      string,
      { type: string; enum?: string[] }
    >;
    expect(props.click_type.type).toBe("string");
    expect(props.click_type.enum).toEqual(["single", "double", "right"]);
  });

  test("schema supports element_id and coordinates", () => {
    const props = schema(computerUseClickTool).properties as Record<
      string,
      { type: string }
    >;
    expect(props.element_id.type).toBe("integer");
    expect(props.x.type).toBe("integer");
    expect(props.y.type).toBe("integer");
  });

  test("execute throws proxy error", () => {
    expect(() => computerUseClickTool.execute({}, ctx)).toThrow("Proxy tool");
  });
});

// ── type_text ───────────────────────────────────────────────────────

describe("computer_use_type_text", () => {
  test("requires text and reasoning", () => {
    expect(schema(computerUseTypeTextTool).required).toContain("text");
    expect(schema(computerUseTypeTextTool).required).toContain("reasoning");
  });

  test("execute throws proxy error", () => {
    expect(() => computerUseTypeTextTool.execute({}, ctx)).toThrow(
      "Proxy tool",
    );
  });
});

// ── key ─────────────────────────────────────────────────────────────

describe("computer_use_key", () => {
  test("requires key and reasoning", () => {
    expect(schema(computerUseKeyTool).required).toContain("key");
    expect(schema(computerUseKeyTool).required).toContain("reasoning");
  });

  test("execute throws proxy error", () => {
    expect(() => computerUseKeyTool.execute({}, ctx)).toThrow("Proxy tool");
  });
});

// ── scroll ──────────────────────────────────────────────────────────

describe("computer_use_scroll", () => {
  test("requires direction, amount, and reasoning", () => {
    expect(schema(computerUseScrollTool).required).toContain("direction");
    expect(schema(computerUseScrollTool).required).toContain("amount");
    expect(schema(computerUseScrollTool).required).toContain("reasoning");
  });

  test("direction enum includes up, down, left, right", () => {
    const props = schema(computerUseScrollTool).properties as Record<
      string,
      { enum?: string[] }
    >;
    expect(props.direction.enum).toEqual(["up", "down", "left", "right"]);
  });
});

// ── drag ────────────────────────────────────────────────────────────

describe("computer_use_drag", () => {
  test("supports source and destination coordinates", () => {
    const props = schema(computerUseDragTool).properties as Record<
      string,
      { type: string }
    >;
    expect(props.element_id.type).toBe("integer");
    expect(props.to_element_id.type).toBe("integer");
    expect(props.x.type).toBe("integer");
    expect(props.y.type).toBe("integer");
    expect(props.to_x.type).toBe("integer");
    expect(props.to_y.type).toBe("integer");
  });

  test("requires reasoning only", () => {
    expect(schema(computerUseDragTool).required).toEqual(["reasoning"]);
  });
});

// ── wait ────────────────────────────────────────────────────────────

describe("computer_use_wait", () => {
  test("requires duration_ms and reasoning", () => {
    expect(schema(computerUseWaitTool).required).toContain("duration_ms");
    expect(schema(computerUseWaitTool).required).toContain("reasoning");
  });
});

// ── open_app ────────────────────────────────────────────────────────

describe("computer_use_open_app", () => {
  test("requires app_name and reasoning", () => {
    expect(schema(computerUseOpenAppTool).required).toContain("app_name");
    expect(schema(computerUseOpenAppTool).required).toContain("reasoning");
  });
});

// ── run_applescript ─────────────────────────────────────────────────

describe("computer_use_run_applescript", () => {
  test("requires script and reasoning", () => {
    expect(schema(computerUseRunAppleScriptTool).required).toContain("script");
    expect(schema(computerUseRunAppleScriptTool).required).toContain(
      "reasoning",
    );
  });

  test("description warns against do shell script", () => {
    expect(computerUseRunAppleScriptTool.description).toContain(
      "do shell script",
    );
    expect(computerUseRunAppleScriptTool.description).toContain("blocked");
  });
});

// ── done ────────────────────────────────────────────────────────────

describe("computer_use_done", () => {
  test("requires summary", () => {
    expect(schema(computerUseDoneTool).required).toContain("summary");
  });
});

// ── respond ─────────────────────────────────────────────────────────

describe("computer_use_respond", () => {
  test("requires answer and reasoning", () => {
    expect(schema(computerUseRespondTool).required).toContain("answer");
    expect(schema(computerUseRespondTool).required).toContain("reasoning");
  });
});

// ── skill-proxy-bridge ──────────────────────────────────────────────

describe("forwardComputerUseProxyTool", () => {
  test("returns error when no proxy resolver available", async () => {
    const result = await forwardComputerUseProxyTool(
      "computer_use_click",
      {},
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("no proxy resolver available");
    expect(result.content).toContain("computer_use_click");
  });

  test("delegates to proxy resolver when available", async () => {
    const ctxWithProxy: ToolContext = {
      ...ctx,
      proxyToolResolver: async (
        name: string,
        input: Record<string, unknown>,
      ) => ({
        content: `Forwarded ${name} with ${JSON.stringify(input)}`,
        isError: false,
      }),
    };

    const result = await forwardComputerUseProxyTool(
      "computer_use_screenshot",
      { reasoning: "test" },
      ctxWithProxy,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Forwarded computer_use_screenshot");
    expect(result.content).toContain("test");
  });
});
