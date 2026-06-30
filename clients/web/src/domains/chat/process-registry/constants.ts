/**
 * Shared cap on the number of stacked chips an overlay pill renders before
 * collapsing the remainder into a "+N" overflow. One source of truth for the
 * subagent / acp-run / background-task stacked pills (and the subagent
 * collapsed avatar row), so the surfaces cap at the same count. 6 matches the
 * Figma mock (6 avatars + "+6").
 */
export const MAX_VISIBLE_STACKED_CHIPS = 6;
