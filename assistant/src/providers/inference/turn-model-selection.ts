/**
 * The inference profile and the concrete model a turn's provider calls
 * actually run on.
 *
 * Every caller that reports, notifies, or gates on "which model is this turn
 * using" must derive the answer the same way dispatch does, or it names a
 * profile or a model the request never ran on. Three things make that true,
 * and all three are easy to drop when the chain is written out by hand:
 *
 * - The winner comes from `selectWinningProfile`, the same dispatch the
 *   provider calls use. A hand-mirrored precedence chain credits profiles the
 *   resolver never consulted (e.g. `activeProfile` on a non-`mainAgent` call
 *   site), falling back to the profileless model key only when no profile
 *   wins.
 * - Selection applies `dispatchProviderResolvable`. Without it, selection can
 *   settle on a profile naming a deleted connection that dispatch skips and
 *   heals past.
 * - The two values answer different questions and are not substitutes. A
 *   weighted mix's winning profile is named by the mix, while the call runs on
 *   one expanded arm, so a caller that needs the model cannot read the profile
 *   key and a caller that names the profile to the user must not read the
 *   model.
 *
 * One function so the agent loop and the direct-wake path cannot drift apart.
 */

import type { z } from "zod";

import {
  resolveProfilelessModelKey,
  selectWinningProfile,
} from "../../config/llm-resolver.js";
import type { LLMCallSite, LLMSchema } from "../../config/schemas/llm.js";
import { dispatchProviderResolvable } from "../connection-resolution.js";

export interface TurnModelSelectionOptions {
  /** The turn's inference-profile override, if it has one. */
  overrideProfile?: string | null | undefined;
  /** Whether the override outranks a call site's own profile pin. */
  forceOverrideProfile?: boolean;
  /** Stable seed for percentage-rollout selection, normally the conversation id. */
  selectionSeed?: string;
}

export interface TurnModelSelection {
  /**
   * The winning profile's key, or the resolved model id when no named profile
   * wins. A weighted mix is named by the mix, never by the arm it expanded to,
   * so a user-facing profile notice built from this cannot leak an A/B arm.
   */
  profileKey: string;
  /**
   * The concrete model id the provider call runs on: the mix-expanded winner
   * with the call site's own model tweak layered on. Capability questions
   * ("can this model see images") have to be asked of this, not of the key.
   */
  model: string;
}

export function resolveTurnModelSelection(
  callSite: LLMCallSite,
  llm: z.infer<typeof LLMSchema>,
  opts: TurnModelSelectionOptions = {},
): TurnModelSelection {
  const { overrideProfile, forceOverrideProfile, selectionSeed } = opts;
  const shared = {
    ...(overrideProfile != null ? { overrideProfile } : {}),
    ...(selectionSeed != null ? { selectionSeed } : {}),
    isResolvableProvider: dispatchProviderResolvable,
  };
  // Despite its name this resolves the call site's whole config and returns
  // its `model`: the mix-expanded winner with the call-site tweak applied,
  // which is both the model dispatch sends to and the stable identity a
  // profileless config is named by.
  const model = resolveProfilelessModelKey(callSite, llm, {
    ...shared,
    ...(forceOverrideProfile ? { forceOverrideProfile: true } : {}),
  });
  return {
    profileKey:
      selectWinningProfile(callSite, llm, shared).profileName ?? model,
    model,
  };
}
