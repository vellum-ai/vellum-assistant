/**
 * Identifiers for the different agents/subsystems that consume LLM tokens.
 */
export type UsageActor =
  | "main_agent"
  | "context_compactor"
  | "task_classifier"
  | "title_generator"
  | "ambient_analyzer"
  | "suggestion_generator"
  | "computer_use_agent"
  | "memory_embedding";
