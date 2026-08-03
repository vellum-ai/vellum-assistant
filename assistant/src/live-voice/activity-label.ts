/**
 * Turns a tool call into one short user-facing line for the surfaces that show
 * a running voice session.
 *
 * ## Why the copy lives here
 *
 * The iOS Live Activity has two drivers that must carry identical content: the
 * live-voice socket, and an APNs push the daemon dispatches when the app is
 * backgrounded and the web layer is suspended. Only one of them runs web code,
 * so a label composed client-side could not be reproduced by the other. Both
 * are therefore handed the same string, and this is where it is made.
 *
 * That does not contradict the rule that phase wording belongs to the web
 * layer. The reason phase copy lives there is cadence: the iOS shell ships on
 * App Store review while the web bundle deploys continuously, so a native
 * `switch` would fossilize. This module deploys with the daemon, i.e.
 * continuously, and it is the only layer that knows a tool ran at all.
 *
 * ## What makes a good label
 *
 * It is read on a Lock Screen, in a glance, by someone who is mid-conversation
 * and not looking for detail. So: a present-participle phrase, no tool names,
 * no arguments, no punctuation, and short enough to survive one line. Arguments
 * are deliberately absent even though {@link summarizeToolInput} could supply
 * them: a path or a URL on a Lock Screen is unreadable at a glance and can
 * carry content the user would not choose to show a passer-by.
 */

/**
 * Present-participle phrases for the built-in tools, by exact name.
 *
 * Grouped by what the user would say is happening, not by how the tool is
 * implemented: `bash` and `host_bash` differ in where they run, which is not a
 * distinction anyone glancing at a Lock Screen is making.
 */
const TOOL_ACTIVITY_LABELS: Readonly<Record<string, string>> = {
  bash: "Running a command",
  terminal: "Running a command",
  host_bash: "Running a command",
  file_read: "Reading a file",
  host_file_read: "Reading a file",
  file_write: "Writing a file",
  host_file_write: "Writing a file",
  file_edit: "Editing a file",
  host_file_edit: "Editing a file",
  host_file_transfer: "Moving a file",
  file_search: "Searching files",
  web_search: "Searching the web",
  web_fetch: "Reading a page",
  network_request: "Making a request",
  browser: "Using the browser",
  computer_use: "Using the computer",
  memory: "Checking memory",
  schedule: "Checking the schedule",
  ui_show: "Putting something on screen",
  ui_update: "Putting something on screen",
};

/**
 * Prefix-matched fallbacks, tried in order when a tool has no exact entry.
 *
 * The tool vocabulary is open: plugins, MCP servers, and skills all contribute
 * names this module has never seen, and a new built-in should not have to be
 * registered here to avoid a blank island. Prefixes cover the families whose
 * names are structured; {@link GENERIC_ACTIVITY_LABEL} covers the rest.
 */
const TOOL_ACTIVITY_LABEL_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["browser_", "Using the browser"],
  ["computer_", "Using the computer"],
  ["file_", "Working with files"],
  ["host_file_", "Working with files"],
  ["web_", "Looking something up"],
  ["mcp_", "Using a connected app"],
  ["skill_", "Running a skill"],
  ["subagent", "Working on it"],
];

/**
 * What an unrecognized tool reads as.
 *
 * Deliberately vague rather than derived from the tool's name. A humanized
 * `slack_conversations_history` is worse than "Working on it": it is longer
 * than the slot, it leaks an internal vocabulary, and it reads like an error
 * message. The label's job is to show the turn is alive and doing something,
 * and this does that job for every tool that will ever exist.
 */
export const GENERIC_ACTIVITY_LABEL = "Working on it";

/**
 * The line to show while `toolName` runs.
 *
 * Total, by construction: every tool gets a label, because the alternative is
 * a surface that goes blank precisely when the assistant is busiest.
 */
export function activityLabelForTool(toolName: string): string {
  const exact = TOOL_ACTIVITY_LABELS[toolName];
  if (exact !== undefined) {
    return exact;
  }
  for (const [prefix, label] of TOOL_ACTIVITY_LABEL_PREFIXES) {
    if (toolName.startsWith(prefix)) {
      return label;
    }
  }
  return GENERIC_ACTIVITY_LABEL;
}
