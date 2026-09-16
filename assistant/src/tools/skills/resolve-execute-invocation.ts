import { getTool } from "../registry.js";
import { resolveToolInvocationAlias } from "../tool-name-aliases.js";
import {
  recoverSkillExecuteEnvelope,
  resolveSkillExecuteInput,
} from "./execute.js";

export function resolveSkillExecuteInvocation(
  input: Record<string, unknown>,
  allowedToolNames?: ReadonlySet<string>,
): { name: string; input: Record<string, unknown> } {
  const envelope = recoverSkillExecuteEnvelope(input);
  const rawToolName = typeof envelope.tool === "string" ? envelope.tool : "";
  const innerSchema = rawToolName
    ? getTool(rawToolName)?.input_schema
    : undefined;
  const rawToolInput = resolveSkillExecuteInput(envelope, innerSchema);

  return resolveToolInvocationAlias(
    rawToolName,
    { ...rawToolInput },
    allowedToolNames,
  );
}
