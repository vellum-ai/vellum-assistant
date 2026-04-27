export type InteractionType = "computer_use" | "text_qa";

/**
 * Heuristic classifier — direct port of the Swift client's logic.
 * Used as fallback when the LLM API call is unavailable or fails.
 */
export function classifyHeuristic(task: string): InteractionType {
  const lower = task.toLowerCase().trim();

  if (lower.includes("?")) return "text_qa";

  const qaStarters = [
    "what",
    "when",
    "where",
    "how",
    "why",
    "who",
    "which",
    "is it",
    "is there",
    "is this",
    "are there",
    "are these",
    "can you tell",
    "can you explain",
    "can you describe",
    "tell me",
    "explain",
    "describe",
    "summarize",
    "list",
  ];
  for (const starter of qaStarters) {
    if (lower.startsWith(starter)) return "text_qa";
  }

  const cuStarters = [
    "open",
    "click",
    "type",
    "navigate",
    "switch",
    "drag",
    "scroll",
    "close",
    "send",
    "fill",
    "submit",
    "go to",
    "move",
    "select",
    "copy",
    "paste",
    "delete",
    "create",
    "write",
    "edit",
    "save",
    "download",
    "upload",
    "install",
    "run",
    "launch",
    "start",
    "stop",
    "press",
    "tap",
    "find",
    "search",
    "show me",
  ];
  for (const starter of cuStarters) {
    if (lower.startsWith(starter)) return "computer_use";
  }

  return "computer_use";
}
