import type { Message } from "../../providers/types.js";

/** Skill ID for the bundled browser skill. */
export const BROWSER_SKILL_ID = "browser";

let toolUseCounter = 0;

/**
 * Build a synthetic conversation history containing a skill_load tool_use
 * and matching tool_result with a <loaded_skill /> marker.
 */
export function buildSkillLoadHistory(
  skillId: string,
  versionHash?: string,
): Message[] {
  const toolUseId = `test-tool-use-${skillId}-${toolUseCounter++}`;
  const versionAttr = versionHash ? ` version="${versionHash}"` : "";
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: toolUseId,
          name: "skill_load",
          input: { skill: skillId },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: `Skill loaded successfully.\n<loaded_skill id="${skillId}"${versionAttr} />`,
        },
      ],
    },
  ];
}
