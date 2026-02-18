import type { Message } from '../../providers/types.js';

/** The 10 browser tool names that are being migrated from core to skill. */
export const BROWSER_TOOL_NAMES = [
  'browser_navigate',
  'browser_snapshot',
  'browser_screenshot',
  'browser_close',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_wait_for',
  'browser_extract',
  'browser_fill_credential',
] as const;

/** Number of browser tools being migrated. */
export const BROWSER_TOOL_COUNT = BROWSER_TOOL_NAMES.length;

/** Skill ID for the bundled browser skill. */
export const BROWSER_SKILL_ID = 'browser';

let toolUseCounter = 0;

/**
 * Build a synthetic conversation history containing a skill_load tool_use
 * and matching tool_result with a <loaded_skill /> marker.
 */
export function buildSkillLoadHistory(skillId: string, versionHash?: string): Message[] {
  const toolUseId = `test-tool-use-${skillId}-${toolUseCounter++}`;
  const versionAttr = versionHash ? ` version="${versionHash}"` : '';
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'skill_load',
          input: { skill: skillId },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: `Skill loaded successfully.\n<loaded_skill id="${skillId}"${versionAttr} />`,
        },
      ],
    },
  ];
}

/**
 * Assert that a set of tool names is exactly the expected set (order-independent).
 */
export function expectToolNamesEqual(actual: string[], expected: readonly string[]): void {
  const sorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(expectedSorted)) {
    throw new Error(
      `Tool names mismatch.\nExpected: ${JSON.stringify(expectedSorted)}\nActual: ${JSON.stringify(sorted)}`
    );
  }
}

/**
 * Assert that all browser tool names are present in a given set.
 */
export function assertBrowserToolsPresent(toolNames: string[]): void {
  for (const name of BROWSER_TOOL_NAMES) {
    if (!toolNames.includes(name)) {
      throw new Error(`Expected browser tool "${name}" to be present in tool names`);
    }
  }
}

/**
 * Assert that no browser tool names are present in a given set.
 */
export function assertBrowserToolsAbsent(toolNames: string[]): void {
  for (const name of BROWSER_TOOL_NAMES) {
    if (toolNames.includes(name)) {
      throw new Error(`Expected browser tool "${name}" to be absent from tool names`);
    }
  }
}
