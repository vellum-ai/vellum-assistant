import { KIMI_CJK_SINGLE_CHAR_TOKEN_IDS } from "./kimi-cjk-token-ids.js";

/**
 * Named logit-bias presets that a profile may opt into via the `logitBias`
 * field on `ProfileEntry` (see `config/schemas/llm.ts`). A preset resolves to a
 * `{ "<tokenId>": bias }` map that OpenAI-compatible providers forward as the
 * `logit_bias` request field.
 *
 * Presets are profile-scoped: `RetryProvider.normalizeSendMessageOptions`
 * resolves the active profile's `logitBias` and only attaches the map on the
 * Fireworks (OpenAI-compatible) path, so it never reaches providers/models it
 * wasn't built for. Token IDs are tokenizer-specific — `suppress-cjk` only makes
 * sense for the Kimi-tokenizer models Fireworks serves.
 *
 * The valid preset names must match the `logitBias` enum in
 * `config/schemas/llm.ts` (kept as a plain literal there to avoid a schema →
 * provider import cycle).
 */

/**
 * Soft negative bias applied to each CJK token. -4 discourages *spontaneous*
 * Chinese (a marginal-probability slip) while leaving explicitly-requested
 * Chinese (dominant-probability tokens) intact. Not a hard ban (-100 would
 * clip legitimate CJK); tunable if slips persist in real usage.
 */
export const SUPPRESS_CJK_BIAS = -4;

let suppressCjkMap: Readonly<Record<string, number>> | undefined;

function buildSuppressCjkMap(): Readonly<Record<string, number>> {
  const map: Record<string, number> = {};
  for (const id of KIMI_CJK_SINGLE_CHAR_TOKEN_IDS) {
    map[id] = SUPPRESS_CJK_BIAS;
  }
  return map;
}

/**
 * Resolve a preset to its `logit_bias` map for `model`, or `undefined` when the
 * preset is unknown or doesn't apply to the model. `suppress-cjk`'s token IDs
 * come from the Kimi tokenizer, so it only resolves for Kimi models — this keeps
 * the preset from being misapplied to a different-tokenizer model that happened
 * to inherit it. The map is built once and cached (a constant ~5.3k-entry object
 * reused across every request on the owning profile).
 */
export function resolveLogitBiasPreset(
  preset: string,
  model: string,
): Readonly<Record<string, number>> | undefined {
  if (preset === "suppress-cjk" && /kimi/i.test(model)) {
    suppressCjkMap ??= buildSuppressCjkMap();
    return suppressCjkMap;
  }
  return undefined;
}
