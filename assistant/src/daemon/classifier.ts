import {
  createTimeout,
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../providers/provider-send-message.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("classifier");

const CLASSIFICATION_TIMEOUT_MS = 5000;

export type InteractionType = "computer_use" | "text_qa";

/**
 * Classify a user task as computer_use or text_qa using an LLM tool-use call,
 * falling back to a heuristic if the API call fails or no API key is available.
 */
export async function classifyInteraction(
  task: string,
  source?: "voice" | "text",
): Promise<InteractionType> {
  if (source === "voice") {
    log.info(
      { source },
      "Voice source detected, skipping classification — routing to text_qa",
    );
    return "text_qa";
  }

  const provider = await getConfiguredProvider();
  if (!provider) {
    log.warn(
      "No configured provider available, falling back to heuristic classification",
    );
    return classifyHeuristic(task);
  }

  try {
    const { signal, cleanup } = createTimeout(CLASSIFICATION_TIMEOUT_MS);
    try {
      const response = await provider.sendMessage(
        [userMessage(task)],
        [
          {
            name: "classify_interaction",
            description: "Classify the user interaction type",
            input_schema: {
              type: "object" as const,
              properties: {
                interaction_type: {
                  type: "string",
                  enum: ["computer_use", "text_qa"],
                  description: "The type of interaction",
                },
                reasoning: {
                  type: "string",
                  description: "Brief reasoning for the classification",
                },
              },
              required: ["interaction_type", "reasoning"],
            },
          },
        ],
        "You are a classifier. Determine whether the user's request requires computer use (controlling the GUI — clicking, scrolling, typing into app windows, navigating between apps) or can be handled with local tools (answering questions, running terminal commands, creating/editing/reading files, web searches, writing code). GUI tasks → computer_use. Everything else → text_qa.",
        {
          config: {
            modelIntent: "latency-optimized",
            max_tokens: 128,
            tool_choice: {
              type: "tool" as const,
              name: "classify_interaction",
            },
          },
          signal,
        },
      );
      cleanup();

      const toolBlock = extractToolUse(response);
      if (toolBlock) {
        const input = toolBlock.input as {
          interaction_type?: string;
          reasoning?: string;
        };
        const result =
          input.interaction_type === "text_qa" ? "text_qa" : "computer_use";
        log.info({ result, reasoning: input.reasoning }, "LLM classification");
        return result;
      }

      log.warn(
        "No tool_use block in classification response, falling back to heuristic",
      );
      return classifyHeuristic(task);
    } finally {
      cleanup();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      { err: message },
      "LLM classification failed, falling back to heuristic",
    );
    return classifyHeuristic(task);
  }
}

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
