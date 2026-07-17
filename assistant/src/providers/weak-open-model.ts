/**
 * Classification of "weak open models" — open-weight models (Kimi K2,
 * DeepSeek, MiniMax, GLM) that disregard static instructions and have
 * capability gaps that capable models (Claude, GPT, Kimi K3+) do not. Used by
 * harness levers that coach or redirect these models without touching
 * capable-model behavior: the task-progress-nudge plugin and the
 * empty-dynamic_page surface redirect.
 *
 * Matching spans provider naming conventions: OpenRouter
 * `moonshotai/kimi-k2.6`, `deepseek/deepseek-chat`, `minimax/minimax-m3`;
 * Fireworks `accounts/fireworks/models/minimax-m3`, `kimi-k2p6`. The Kimi
 * branch is scoped to the K2 generation: frontier-class successors
 * (`kimi-k3`, and OpenRouter's `kimi-latest` alias that resolves to it) do
 * not show these gaps and are deliberately unmatched. Membership is
 * evidence-based — extend the pattern only as models show the same gaps.
 *
 * Distinct from exploration-drift's narrower `LOOP_PRONE_MODEL_PATTERN`, which
 * targets specific loop-prone versions rather than the whole capability class.
 */
export const WEAK_OPEN_MODEL_PATTERN = /kimi-k2|deepseek|minimax|glm/i;

/** True when `model` is a weak open model (see {@link WEAK_OPEN_MODEL_PATTERN}). */
export function isWeakOpenModel(model: string | null | undefined): boolean {
  return typeof model === "string" && WEAK_OPEN_MODEL_PATTERN.test(model);
}
