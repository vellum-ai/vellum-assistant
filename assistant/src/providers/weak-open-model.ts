/**
 * Classifier for the open models the assistant ships as lower-cost profiles
 * (currently Kimi K2.6 and MiniMax M3, the `balanced-economy` / `open-router`
 * profile models). These need explicit behavioral scaffolding that the managed
 * Claude profiles do not: they re-issue identical exploration calls in a loop,
 * confidently assert unverified facts, and defer to the user ("do you have X
 * set up?") instead of just attempting an available tool. Default plugins gate
 * model-specific nudges on this set.
 *
 * Matched across provider naming conventions: Fireworks spells the version dot
 * as `p` (`accounts/fireworks/models/kimi-k2p6`,
 * `accounts/fireworks/models/minimax-m3`); OpenRouter reports
 * `moonshotai/kimi-k2.6` and `minimax/minimax-m3`. Extend the pattern as other
 * models exhibit the same need.
 */
export const WEAK_OPEN_MODEL_PATTERN = /kimi-k2[p.]6|minimax-m3/i;

/** True when `model` is an open model that needs extra behavioral scaffolding. */
export function isWeakOpenModel(model: string): boolean {
  return WEAK_OPEN_MODEL_PATTERN.test(model);
}
