import { describe, expect, test } from "bun:test";

import type { ToolDefinition } from "../providers/types.js";
import { ACTIVATION_MOMENT_PARAMS } from "../telemetry/activation-funnel.js";
import {
  injectActivationMomentParam,
  projectUiToolsForChannel,
} from "../tools/ui-surface/channel-variants.js";
import {
  uiDismissTool,
  uiShowTool,
  uiUpdateTool,
} from "../tools/ui-surface/definitions.js";

const defs: ToolDefinition[] = [
  uiShowTool,
  uiUpdateTool,
  uiDismissTool,
  {
    name: "bash",
    description: "run a command",
    input_schema: { type: "object" },
  },
];

function surfaceTypeEnum(def: ToolDefinition): string[] {
  return (
    def.input_schema as { properties: { surface_type: { enum: string[] } } }
  ).properties.surface_type.enum;
}

describe("projectUiToolsForChannel", () => {
  test("returns the same array for channels without a variant", () => {
    for (const channel of [undefined, "macos", "telegram", "phone"]) {
      expect(projectUiToolsForChannel(defs, channel)).toBe(defs);
    }
  });

  test("slack gets a task_progress-only ui_show", () => {
    const projected = projectUiToolsForChannel(defs, "slack");
    const uiShow = projected.find((d) => d.name === "ui_show")!;

    expect(surfaceTypeEnum(uiShow)).toEqual(["card"]);
    expect(uiShow.description).toContain("task_progress");
    expect(uiShow.description).toContain(
      "the only surface this channel renders",
    );
    expect(uiShow.description).not.toContain("oauth_connect");
    expect(uiShow.description).not.toContain("dynamic_page");
    expect(uiShow.description!.length).toBeLessThan(
      uiShowTool.description.length / 2,
    );
  });

  test("slack projection keeps execute and leaves other tools untouched", () => {
    const projected = projectUiToolsForChannel(defs, "slack");
    const uiShow = projected.find((d) => d.name === "ui_show") as {
      execute?: unknown;
    };

    expect(uiShow.execute).toBe(uiShowTool.execute);
    expect(projected.find((d) => d.name === "ui_update")).toBe(uiUpdateTool);
    expect(projected.find((d) => d.name === "ui_dismiss")).toBe(uiDismissTool);
    expect(projected.find((d) => d.name === "bash")).toBe(defs[3]);
  });

  test("projection never mutates the shared definitions", () => {
    const descriptionBefore = uiShowTool.description;
    const schemaBefore = JSON.stringify(uiShowTool.input_schema);

    projectUiToolsForChannel(defs, "slack");

    expect(uiShowTool.description).toBe(descriptionBefore);
    expect(JSON.stringify(uiShowTool.input_schema)).toBe(schemaBefore);
  });
});

describe("injectActivationMomentParam", () => {
  function properties(def: ToolDefinition): Record<string, unknown> {
    return (def.input_schema as { properties: Record<string, unknown> })
      .properties;
  }

  test("the standard ui_show schema does not carry activation_moment", () => {
    expect(properties(uiShowTool).activation_moment).toBeUndefined();
  });

  test("adds the optional param to ui_show only, leaving required unchanged", () => {
    const projected = injectActivationMomentParam(defs);
    const uiShow = projected.find((d) => d.name === "ui_show")!;

    const param = properties(uiShow).activation_moment as { enum: string[] };
    expect(param).toBeDefined();
    expect(param.enum).toEqual([...ACTIVATION_MOMENT_PARAMS]);
    expect((uiShow.input_schema as { required: string[] }).required).toEqual([
      "surface_type",
      "data",
    ]);
    expect(projected.find((d) => d.name === "ui_update")).toBe(uiUpdateTool);
    expect(projected.find((d) => d.name === "bash")).toBe(defs[3]);
  });

  test("injection never mutates the shared definition", () => {
    const before = JSON.stringify(uiShowTool.input_schema);
    injectActivationMomentParam(defs);
    expect(JSON.stringify(uiShowTool.input_schema)).toBe(before);
  });
});
