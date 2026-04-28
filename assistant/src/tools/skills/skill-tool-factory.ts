import type { SkillToolEntry } from "../../config/skills.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
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
 * Validate that all keys in `input` are declared in the tool's input_schema
 * properties. Returns an error result listing unknown parameters, or undefined
 * if validation passes.
 */
function validateNoUnknownParams(
  toolName: string,
  input: Record<string, unknown>,
  schema: SkillToolEntry["input_schema"],
): ToolExecutionResult | undefined {
  const properties = schema?.properties;
  if (!properties) return undefined;

  const knownKeys = new Set(Object.keys(properties));
  const unknownKeys = Object.keys(input).filter((k) => !knownKeys.has(k));
  if (unknownKeys.length === 0) return undefined;

  const listed = unknownKeys.map((k) => `"${k}"`).join(", ");
  const supported = [...knownKeys].map((k) => `"${k}"`).join(", ");
  return {
    content: `Unknown parameter${unknownKeys.length > 1 ? "s" : ""} ${listed} for tool "${toolName}". Supported parameters: ${supported}. Remove unsupported parameters and retry.`,
    isError: true,
  };
}

/**
 * Create a runtime Tool object from a manifest entry.
 * Maps SkillToolEntry metadata to the Tool interface and routes execution
 * through the skill script runner.
 */
export function createSkillTool(
  entry: SkillToolEntry,
  skillId: string,
  skillDir: string,
  versionHash: string,
  bundled?: boolean,
): Tool {
  return {
    name: entry.name,
    description: entry.description,
    category: entry.category,
    defaultRiskLevel: riskMap[entry.risk],
    origin: "skill",
    ownerSkillId: skillId,
    executionTarget: entry.execution_target as ExecutionTarget,
    ownerSkillVersionHash: versionHash,
    ownerSkillBundled: bundled,

    getDefinition(): ToolDefinition {
      return {
        name: entry.name,
        description: entry.description,
        input_schema: entry.input_schema as ToolDefinition["input_schema"],
      };
    },

    async execute(
      input: Record<string, unknown>,
      context: ToolContext,
    ): Promise<ToolExecutionResult> {
      const validationError = validateNoUnknownParams(
        entry.name,
        input,
        entry.input_schema,
      );
      if (validationError) return validationError;

      return runSkillToolScript(skillDir, entry.executor, input, context, {
        target: entry.execution_target,
        expectedSkillVersionHash: versionHash,
        bundled,
      });
    },
  };
}

/**
 * Create runtime Tool objects from all entries in a manifest.
 */
export function createSkillToolsFromManifest(
  entries: SkillToolEntry[],
  skillId: string,
  skillDir: string,
  versionHash: string,
  bundled?: boolean,
): Tool[] {
  return entries.map((entry) =>
    createSkillTool(entry, skillId, skillDir, versionHash, bundled),
  );
}
