/**
 * Family-level classification of "weak open models" — open-weight models
 * (Kimi, DeepSeek, MiniMax, GLM) that disregard static instructions and have
 * capability gaps that capable models (Claude, GPT) do not. Used by harness
 * levers that coach or redirect these models without touching capable-model
 * behavior: the task-progress-nudge plugin and the empty-dynamic_page surface
 * redirect.
 *
 * Family-level matching spans provider naming conventions: OpenRouter
 * `moonshotai/kimi-k2.6`, `deepseek/deepseek-chat`, `minimax/minimax-m3`;
 * Fireworks `accounts/fireworks/models/minimax-m3`, `kimi-k2p6`. Extend the
 * pattern as other open models show the same gaps.
 *
 * Distinct from exploration-drift's narrower `LOOP_PRONE_MODEL_PATTERN`, which
 * targets specific loop-prone versions rather than the whole capability family.
 */
export const WEAK_OPEN_MODEL_PATTERN = /kimi|deepseek|minimax|glm/i;

/** True when `model` is a weak open model (see {@link WEAK_OPEN_MODEL_PATTERN}). */
export function isWeakOpenModel(model: string | null | undefined): boolean {
  return typeof model === "string" && WEAK_OPEN_MODEL_PATTERN.test(model);
}
