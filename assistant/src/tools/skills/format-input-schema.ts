import { getWorkspaceDirDisplay } from "../../util/platform.js";

/** Preserve nested fields and alternatives when disclosing a skill's input. */
export function formatSkillInputSchema(schema: object): string {
  const workspaceDir = getWorkspaceDirDisplay();
  const json = JSON.stringify(
    schema,
    (_key, value: unknown) =>
      typeof value === "string"
        ? value.replaceAll("{workspaceDir}", workspaceDir)
        : value,
    2,
  );
  return `Input schema for \`skill_execute.input\`:\n\`\`\`json\n${json}\n\`\`\``;
}
