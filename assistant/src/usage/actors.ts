/**
 * Identifiers for the different agents/subsystems that consume LLM tokens.
 */
export type UsageActor =
  | 'main_agent'
  | 'context_compactor'
  | 'task_classifier'
  | 'title_generator'
  | 'ambient_analyzer'
  | 'suggestion_generator'
  | 'computer_use_agent'
  | 'memory_embedding';

/** All valid actor identifiers (useful for runtime validation). */
export const USAGE_ACTORS: readonly UsageActor[] = [
  'main_agent',
  'context_compactor',
  'task_classifier',
  'title_generator',
  'ambient_analyzer',
  'suggestion_generator',
  'computer_use_agent',
  'memory_embedding',
] as const;
