/**
 * Reusable constants and helpers for the computer-use skill migration test suite.
 */

/** The 11 computer_use_* action tool names provided by the bundled computer-use skill. */
export const COMPUTER_USE_TOOL_NAMES = [
  "computer_use_observe",
  "computer_use_click",
  "computer_use_type_text",
  "computer_use_key",
  "computer_use_scroll",
  "computer_use_drag",
  "computer_use_wait",
  "computer_use_open_app",
  "computer_use_run_applescript",
  "computer_use_done",
  "computer_use_respond",
] as const;

/** Number of computer_use_* tools. */
export const COMPUTER_USE_TOOL_COUNT = COMPUTER_USE_TOOL_NAMES.length; // 11
