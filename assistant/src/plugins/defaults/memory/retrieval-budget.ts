export interface RecallBudgetInput {
  estimatedPromptTokens: number;
  maxInputTokens: number;
  targetHeadroomTokens: number;
  minInjectTokens: number;
  maxInjectTokens: number;
}

/**
 * Compute per-turn memory recall injection budget from context headroom.
 *
 * The result is always clamped into [minInjectTokens, maxInjectTokens].
 */
export function computeRecallBudget(input: RecallBudgetInput): number {
  const maxInput = Math.max(0, Math.floor(input.maxInputTokens));
  const estimatedPrompt = Math.max(0, Math.floor(input.estimatedPromptTokens));
  const headroomTarget = Math.max(0, Math.floor(input.targetHeadroomTokens));
  const minInject = Math.max(1, Math.floor(input.minInjectTokens));
  const maxInject = Math.max(minInject, Math.floor(input.maxInjectTokens));

  const available = maxInput - estimatedPrompt - headroomTarget;
  return clamp(Math.floor(available), minInject, maxInject);
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
