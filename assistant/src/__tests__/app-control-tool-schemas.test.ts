import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { forwardAppControlProxyTool } from "../tools/app-control/skill-proxy-bridge.js";
import type { ToolContext } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Load TOOLS.json (the production source of truth for app-control tool
// schemas, consumed by the bundled-skill registry).
// ---------------------------------------------------------------------------

interface JsonSchemaProp {
  type?: string;
  enum?: string[];
  items?: { type?: string };
  description?: string;
}

interface JsonSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchemaProp>;
}

interface ToolEntry {
  name: string;
  description: string;
  category: string;
  risk: string;
  input_schema: JsonSchema;
  executor: string;
  execution_target: string;
}

interface ToolsJson {
  version: number;
  tools: ToolEntry[];
}

const TOOLS_JSON_PATH = join(
  import.meta.dir,
  "..",
  "config",
  "bundled-skills",
  "app-control",
  "TOOLS.json",
);

const toolsJson: ToolsJson = JSON.parse(readFileSync(TOOLS_JSON_PATH, "utf-8"));

function toolByName(name: string): ToolEntry {
  const tool = toolsJson.tools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`tool ${name} not found in TOOLS.json`);
  }
  return tool;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Lightweight, schema-driven validator covering the cases this PR exercises:
 *   - all `required` keys must be present
 *   - typed properties (`string` / `integer` / `number` / `boolean`) must match
 *   - `enum`-constrained string properties must be in the allowed set
 *   - `array`-typed properties must be arrays (and items must satisfy
 *     declared item types when present)
 *
 * This mirrors what a JSON-Schema validator like ajv would do for these
 * simple shapes, without pulling ajv in as a direct dependency.
 */
function validate(
  s: JsonSchema,
  input: Record<string, unknown>,
): { ok: boolean; error?: string } {
  for (const key of s.required ?? []) {
    if (!(key in input)) {
      return { ok: false, error: `missing required property: ${key}` };
    }
  }
  for (const [key, propSchema] of Object.entries(s.properties ?? {})) {
    if (!(key in input)) continue;
    const value = input[key];
    if (!propSchema.type) continue;
    switch (propSchema.type) {
      case "string":
        if (typeof value !== "string") {
          return { ok: false, error: `${key} must be string` };
        }
        if (propSchema.enum && !propSchema.enum.includes(value)) {
          return {
            ok: false,
            error: `${key} must be one of ${propSchema.enum.join(", ")}`,
          };
        }
        break;
      case "integer":
        if (typeof value !== "number" || !Number.isInteger(value)) {
          return { ok: false, error: `${key} must be integer` };
        }
        break;
      case "number":
        if (typeof value !== "number") {
          return { ok: false, error: `${key} must be number` };
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          return { ok: false, error: `${key} must be boolean` };
        }
        break;
      case "array":
        if (!Array.isArray(value)) {
          return { ok: false, error: `${key} must be array` };
        }
        if (propSchema.items?.type) {
          for (const item of value) {
            if (
              propSchema.items.type === "string" &&
              typeof item !== "string"
            ) {
              return { ok: false, error: `${key} items must be string` };
            }
          }
        }
        break;
    }
  }
  return { ok: true };
}

const ctx: ToolContext = {
  workingDir: "/tmp",
  conversationId: "test-conversation",
  trustClass: "guardian",
};

// ---------------------------------------------------------------------------
// Aggregate invariants
// ---------------------------------------------------------------------------

describe("app-control TOOLS.json (aggregate)", () => {
  test("contains exactly 9 tools", () => {
    expect(toolsJson.tools.length).toBe(9);
  });

  test("all tools target host execution", () => {
    for (const tool of toolsJson.tools) {
      expect(tool.execution_target).toBe("host");
    }
  });

  test("all tools belong to the app-control category", () => {
    for (const tool of toolsJson.tools) {
      expect(tool.category).toBe("app-control");
    }
  });

  test("all tools have unique names", () => {
    const names = toolsJson.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("all tool names use the app_control_ prefix", () => {
    for (const tool of toolsJson.tools) {
      expect(tool.name.startsWith("app_control_")).toBe(true);
    }
  });

  test("all tools have non-empty descriptions", () => {
    for (const tool of toolsJson.tools) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  test("every tool declares an `app` schema property (required for all but stop)", () => {
    for (const tool of toolsJson.tools) {
      const props = tool.input_schema.properties ?? {};
      expect(
        props.app,
        `${tool.name} must declare an 'app' property`,
      ).toBeDefined();
      expect(props.app.type).toBe("string");

      if (tool.name === "app_control_stop") {
        // stop is the terminal tool; `app` is optional.
        expect(tool.input_schema.required ?? []).not.toContain("app");
      } else {
        // every other tool requires `app`.
        expect(tool.input_schema.required ?? []).toContain("app");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Per-tool schema cases
// ---------------------------------------------------------------------------

describe("app_control_start", () => {
  const tool = toolByName("app_control_start");
  const s = tool.input_schema;

  test("well-formed input passes (with args)", () => {
    expect(
      validate(s, {
        app: "com.apple.Safari",
        args: ["--new-window"],
        reasoning: "open Safari fresh",
      }).ok,
    ).toBe(true);
  });

  test("well-formed input passes (without optional args)", () => {
    expect(
      validate(s, { app: "com.apple.Safari", reasoning: "focus" }).ok,
    ).toBe(true);
  });

  test("missing required app rejects", () => {
    const result = validate(s, { reasoning: "focus" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("app");
  });

  test("declares medium risk", () => {
    expect(tool.risk).toBe("medium");
  });
});

describe("app_control_observe", () => {
  const tool = toolByName("app_control_observe");
  const s = tool.input_schema;

  test("well-formed input passes", () => {
    expect(validate(s, { app: "com.apple.Safari" }).ok).toBe(true);
  });

  test("well-formed input passes (with optional settle_ms override)", () => {
    expect(validate(s, { app: "com.apple.Safari", settle_ms: 0 }).ok).toBe(
      true,
    );
    expect(validate(s, { app: "com.apple.Safari", settle_ms: 500 }).ok).toBe(
      true,
    );
  });

  test("non-integer settle_ms rejects", () => {
    const result = validate(s, {
      app: "com.apple.Safari",
      settle_ms: "200",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("settle_ms");
  });

  test("missing required app rejects", () => {
    const result = validate(s, {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("app");
  });

  test("settle_ms is optional", () => {
    expect(s.required ?? []).not.toContain("settle_ms");
  });

  test("declares low risk", () => {
    expect(tool.risk).toBe("low");
  });
});

describe("app_control_press", () => {
  const s = toolByName("app_control_press").input_schema;

  test("well-formed input passes (with optional fields)", () => {
    expect(
      validate(s, {
        app: "com.apple.Safari",
        key: "return",
        modifiers: ["cmd"],
        duration_ms: 50,
        reasoning: "submit form",
      }).ok,
    ).toBe(true);
  });

  test("well-formed input passes (minimal)", () => {
    expect(
      validate(s, {
        app: "com.apple.Safari",
        key: "a",
        reasoning: "type a",
      }).ok,
    ).toBe(true);
  });

  test("missing required app rejects", () => {
    const result = validate(s, { key: "a", reasoning: "type a" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("app");
  });

  test("missing required key rejects", () => {
    const result = validate(s, {
      app: "com.apple.Safari",
      reasoning: "press something",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("key");
  });
});

describe("app_control_combo", () => {
  const s = toolByName("app_control_combo").input_schema;

  test("well-formed input passes", () => {
    expect(
      validate(s, {
        app: "com.apple.Safari",
        keys: ["cmd", "shift", "4"],
        reasoning: "screenshot region",
      }).ok,
    ).toBe(true);
  });

  test("missing required app rejects", () => {
    const result = validate(s, {
      keys: ["cmd", "a"],
      reasoning: "select all",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("app");
  });

  test("non-array keys rejects", () => {
    const result = validate(s, {
      app: "com.apple.Safari",
      keys: "cmd+a",
      reasoning: "select all",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("keys");
  });
});

describe("app_control_sequence", () => {
  const s = toolByName("app_control_sequence").input_schema;

  test("well-formed input passes (minimal step)", () => {
    expect(
      validate(s, {
        app: "com.apple.Safari",
        steps: [{ key: "right" }],
        reasoning: "advance one step",
      }).ok,
    ).toBe(true);
  });

  test("well-formed input passes (full step fields)", () => {
    expect(
      validate(s, {
        app: "com.apple.Safari",
        steps: [
          { key: "right", duration_ms: 50, gap_ms: 30 },
          { key: "a", modifiers: ["cmd"], duration_ms: 50, gap_ms: 30 },
        ],
        reasoning: "navigate menu",
      }).ok,
    ).toBe(true);
  });

  test("missing required app rejects", () => {
    const result = validate(s, {
      steps: [{ key: "right" }],
      reasoning: "navigate",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("app");
  });

  test("missing required steps rejects", () => {
    const result = validate(s, {
      app: "com.apple.Safari",
      reasoning: "navigate",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("steps");
  });

  test("non-array steps rejects", () => {
    const result = validate(s, {
      app: "com.apple.Safari",
      steps: "right,right",
      reasoning: "navigate",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("steps");
  });

  test("declares low risk", () => {
    expect(toolByName("app_control_sequence").risk).toBe("low");
  });
});

describe("app_control_type", () => {
  const s = toolByName("app_control_type").input_schema;

  test("well-formed input passes", () => {
    expect(
      validate(s, {
        app: "com.apple.Safari",
        text: "hello",
        reasoning: "search",
      }).ok,
    ).toBe(true);
  });

  test("missing required app rejects", () => {
    const result = validate(s, { text: "hello", reasoning: "search" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("app");
  });

  test("missing required text rejects", () => {
    const result = validate(s, {
      app: "com.apple.Safari",
      reasoning: "search",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("text");
  });
});

describe("app_control_click", () => {
  const s = toolByName("app_control_click").input_schema;

  test("well-formed input passes (defaults)", () => {
    expect(
      validate(s, {
        app: "com.apple.Safari",
        x: 100,
        y: 200,
        reasoning: "tap link",
      }).ok,
    ).toBe(true);
  });

  test("well-formed input passes (right button + double)", () => {
    expect(
      validate(s, {
        app: "com.apple.Safari",
        x: 100,
        y: 200,
        button: "right",
        double: true,
        reasoning: "context menu",
      }).ok,
    ).toBe(true);
  });

  test("missing required app rejects", () => {
    const result = validate(s, { x: 100, y: 200, reasoning: "click" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("app");
  });

  test("missing required coordinate rejects", () => {
    const result = validate(s, {
      app: "com.apple.Safari",
      x: 100,
      reasoning: "click",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("y");
  });

  test("invalid button enum value rejects", () => {
    const result = validate(s, {
      app: "com.apple.Safari",
      x: 100,
      y: 200,
      button: "scroll",
      reasoning: "click",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("button");
  });

  test("button enum is left/right/middle", () => {
    const props = s.properties as Record<string, JsonSchemaProp>;
    expect(props.button.enum).toEqual(["left", "right", "middle"]);
  });
});

describe("app_control_drag", () => {
  const s = toolByName("app_control_drag").input_schema;

  test("well-formed input passes", () => {
    expect(
      validate(s, {
        app: "com.apple.Safari",
        from_x: 10,
        from_y: 20,
        to_x: 100,
        to_y: 200,
        reasoning: "drag handle",
      }).ok,
    ).toBe(true);
  });

  test("missing required app rejects", () => {
    const result = validate(s, {
      from_x: 10,
      from_y: 20,
      to_x: 100,
      to_y: 200,
      reasoning: "drag",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("app");
  });

  test("missing required destination rejects", () => {
    const result = validate(s, {
      app: "com.apple.Safari",
      from_x: 10,
      from_y: 20,
      reasoning: "drag",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("to_");
  });

  test("invalid button enum value rejects", () => {
    const result = validate(s, {
      app: "com.apple.Safari",
      from_x: 10,
      from_y: 20,
      to_x: 100,
      to_y: 200,
      button: "scroll",
      reasoning: "drag",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("button");
  });

  test("button enum is left/right/middle", () => {
    const props = s.properties as Record<string, JsonSchemaProp>;
    expect(props.button.enum).toEqual(["left", "right", "middle"]);
  });
});

describe("app_control_stop", () => {
  const s = toolByName("app_control_stop").input_schema;

  test("well-formed input passes (no app — terminal)", () => {
    expect(validate(s, {}).ok).toBe(true);
  });

  test("well-formed input passes (with app + reason)", () => {
    expect(
      validate(s, {
        app: "com.apple.Safari",
        reason: "task complete",
      }).ok,
    ).toBe(true);
  });

  test("app is optional (terminal tool may omit it)", () => {
    expect(s.required ?? []).not.toContain("app");
  });
});

// ---------------------------------------------------------------------------
// skill-proxy-bridge
// ---------------------------------------------------------------------------

describe("forwardAppControlProxyTool", () => {
  test("returns error when no proxy resolver available", async () => {
    const result = await forwardAppControlProxyTool(
      "app_control_click",
      { app: "com.apple.Safari", x: 1, y: 2 },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no proxy resolver available");
    expect(result.content).toContain("app_control_click");
  });

  test("delegates to proxy resolver when available", async () => {
    let capturedName = "";
    let capturedInput: Record<string, unknown> = {};
    const ctxWithProxy: ToolContext = {
      ...ctx,
      proxyToolResolver: async (name, input) => {
        capturedName = name;
        capturedInput = input;
        return { content: `Forwarded ${name}`, isError: false };
      },
    };

    const result = await forwardAppControlProxyTool(
      "app_control_press",
      { app: "com.apple.Safari", key: "return", reasoning: "submit" },
      ctxWithProxy,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe("Forwarded app_control_press");
    expect(capturedName).toBe("app_control_press");
    expect(capturedInput).toEqual({
      app: "com.apple.Safari",
      key: "return",
      reasoning: "submit",
    });
  });
});
