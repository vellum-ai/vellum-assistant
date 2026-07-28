/**
 * `visualize_guide` — serves the visual-authoring design system: the core
 * document plus one document per requested module.
 *
 * The result is plain markdown so the model reads it as instructions rather
 * than data. Unknown module names fail with a teaching error naming the valid
 * set instead of silently returning partial guidance.
 */

import {
  RiskLevel,
  type Tool,
  type ToolExecutionResult,
} from "@vellumai/plugin-api";

import { CORE_GUIDE } from "./guide-core.js";
import {
  getModuleGuide,
  isVisualizeGuideModule,
  MODULE_SUMMARIES,
  VISUALIZE_GUIDE_MODULES,
  type VisualizeGuideModule,
} from "./guide-modules.js";

const MODULE_LIST = VISUALIZE_GUIDE_MODULES.map(
  (name) => `${name} (${MODULE_SUMMARIES[name]})`,
).join(", ");

function error(message: string): ToolExecutionResult {
  return { content: message, isError: true };
}

/**
 * Normalize the `modules` argument into a de-duplicated, canonically ordered
 * module list, or return the offending values.
 */
function parseModules(
  raw: unknown,
): { modules: VisualizeGuideModule[] } | { invalid: string[] } {
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const invalid: string[] = [];
  const selected = new Set<VisualizeGuideModule>();
  for (const value of values) {
    if (isVisualizeGuideModule(value)) {
      selected.add(value);
    } else {
      invalid.push(typeof value === "string" ? value : JSON.stringify(value));
    }
  }
  if (invalid.length > 0) {
    return { invalid };
  }
  return {
    modules: VISUALIZE_GUIDE_MODULES.filter((name) => selected.has(name)),
  };
}

export const visualizeGuideTool: Tool = {
  name: "visualize_guide",
  description: [
    "Loads the design-system guidance for authoring inline visuals.",
    "Call this once per conversation before the first visualize_render — the rendered HTML must follow it.",
    `Pass the modules relevant to what you are about to draw: ${MODULE_LIST}.`,
    "Returns markdown: the core rules plus one document per requested module.",
  ].join("\n"),
  defaultRiskLevel: RiskLevel.Low,
  executionTarget: "sandbox",
  category: "plugin",
  input_schema: {
    type: "object",
    properties: {
      modules: {
        type: "array",
        description:
          "Guidance modules to load alongside the core design system. Pick the ones matching what you are about to draw.",
        items: {
          type: "string",
          enum: [...VISUALIZE_GUIDE_MODULES],
        },
        minItems: 1,
      },
    },
    required: ["modules"],
    additionalProperties: false,
  },
  async execute(input): Promise<ToolExecutionResult> {
    const parsed = parseModules(input.modules);
    if ("invalid" in parsed) {
      return error(
        `Unknown visualize_guide module(s): ${parsed.invalid.join(", ")}. ` +
          `Valid modules are: ${MODULE_LIST}. Call visualize_guide again with only those names.`,
      );
    }
    if (parsed.modules.length === 0) {
      return error(
        `visualize_guide needs at least one module. Valid modules are: ${MODULE_LIST}. ` +
          "Pick the ones matching the visual you are about to draw.",
      );
    }

    const sections = [
      CORE_GUIDE,
      ...parsed.modules.map((name) => getModuleGuide(name)),
    ];
    return { content: sections.join("\n\n---\n\n"), isError: false };
  },
};
