import type { DictationRequest } from "../message-protocol.js";

// Action verbs for fast heuristic fallback (used when LLM classifier is unavailable)
const ACTION_VERBS = [
  "slack",
  "email",
  "send",
  "create",
  "open",
  "search",
  "find",
  "message",
  "text",
  "schedule",
  "remind",
  "launch",
  "navigate",
];

type DictationMode = "dictation" | "command" | "action";

/** Fast heuristic fallback — used when LLM classifier is unavailable or fails. */
export function detectDictationModeHeuristic(
  msg: DictationRequest,
): DictationMode {
  // Command mode: selected text present — treat transcription as a transformation instruction
  if (msg.context.selectedText && msg.context.selectedText.trim().length > 0) {
    return "command";
  }

  // Action mode: transcription starts with an action verb
  const firstWord =
    msg.transcription.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (ACTION_VERBS.includes(firstWord)) {
    return "action";
  }

  // Dictation mode: cursor is in a text field with no selection — clean up for typing
  if (msg.context.cursorInTextField) {
    return "dictation";
  }

  return "dictation";
}
