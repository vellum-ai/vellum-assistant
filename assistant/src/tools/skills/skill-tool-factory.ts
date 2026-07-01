import type { SkillToolEntry } from "../../config/skills.js";
import { RiskLevel } from "../../permissions/types.js";
import {
  coerceStringBooleans,
  coerceStringNumbers,
  validateInputAgainstSchema,
} from "../../skills/validate-input.js";
import type {
  ExecutionTarget,
  Tool,
  ToolContext,
  ToolExecutionResult,
} from "../types.js";
import { runSkillToolScript } from "./skill-script-runner.js";

const riskMap: Record<SkillToolEntry["risk"], RiskLevel> = {
  low: RiskLevel.Low,
  medium: RiskLevel.Medium,
  high: RiskLevel.High,
};

/**
 * Create a runtime Tool object from a manifest entry.
 * Maps SkillToolEntry metadata to the Tool interface and routes execution
 * through the skill script runner. Ownership (the originating skill id) is
 * recorded by the tool registry at `registerSkillTools(skillId, tools)`
 * time, not stamped on the `Tool` object — see
 * {@link ../../tools/registry.getToolOwner}.
 */
export function createSkillTool(
  entry: SkillToolEntry,
  skillDir: string,
  versionHash: string,
  bundled?: boolean,
): Tool {
  return {
    name: entry.name,
    description: entry.description,
    category: entry.category,
    defaultRiskLevel: riskMap[entry.risk],
    executionTarget: entry.execution_target as ExecutionTarget,

    input_schema: entry.input_schema as object,

    async execute(
      input: Record<string, unknown>,
      context: ToolContext,
    ): Promise<ToolExecutionResult> {
      const schema = entry.input_schema as Record<string, unknown> | undefined;
      const coercedInput = coerceStringNumbers(
        coerceStringBooleans(input, schema),
        schema,
      );
      const validation = validateInputAgainstSchema(
        entry.name,
        coercedInput,
        schema,
      );
      if (!validation.ok) {
        return {
          content: `Invalid input for tool "${entry.name}": ${validation.errors.join("; ")}. Fix the arguments and retry.`,
          isError: true,
        };
      }

      return runSkillToolScript(
        skillDir,
        entry.executor,
        coercedInput,
        context,
        {
          target: entry.execution_target,
          expectedSkillVersionHash: versionHash,
          bundled,
        },
      );
    },
  };
}

/**
 * Create runtime Tool objects from all entries in a manifest.
 * The caller is responsible for passing the resulting array to
 * `registerSkillTools(skillId, tools)`, which is where ownership is
 * recorded.
 */
export function createSkillToolsFromManifest(
  entries: SkillToolEntry[],
  skillDir: string,
  versionHash: string,
  bundled?: boolean,
): Tool[] {
  return entries.map((entry) =>
    createSkillTool(entry, skillDir, versionHash, bundled),
  );
}
