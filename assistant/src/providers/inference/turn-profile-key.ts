/**
 * The inference profile key a turn's provider calls actually run on.
 *
 * Every caller that reports, notifies, or gates on "which model is this turn
 * using" must derive the answer the same way dispatch does, or it names a
 * profile the request never ran on. Two things make that true, and both are
 * easy to drop when the chain is written out by hand:
 *
 * - The winner comes from `selectWinningProfile`, the same dispatch the
 *   provider calls use. A hand-mirrored precedence chain credits profiles the
 *   resolver never consulted (e.g. `activeProfile` on a non-`mainAgent` call
 *   site), falling back to the profileless model key only when no profile
 *   wins.
 * - Selection applies `dispatchProviderResolvable`. Without it, selection can
 *   settle on a profile naming a deleted connection that dispatch skips and
 *   heals past.
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

export interface TurnModelProfileKeyOptions {
  /** The turn's inference-profile override, if it has one. */
  overrideProfile?: string | null | undefined;
  /** Whether the override outranks a call site's own profile pin. */
  forceOverrideProfile?: boolean;
  /** Stable seed for percentage-rollout selection, normally the conversation id. */
  selectionSeed?: string;
}

export function resolveTurnModelProfileKey(
  callSite: LLMCallSite,
  llm: z.infer<typeof LLMSchema>,
  opts: TurnModelProfileKeyOptions = {},
): string {
  const { overrideProfile, forceOverrideProfile, selectionSeed } = opts;
  const shared = {
    ...(overrideProfile != null ? { overrideProfile } : {}),
    ...(selectionSeed != null ? { selectionSeed } : {}),
    isResolvableProvider: dispatchProviderResolvable,
  };
  return (
    selectWinningProfile(callSite, llm, shared).profileName ??
    resolveProfilelessModelKey(callSite, llm, {
      ...shared,
      ...(forceOverrideProfile ? { forceOverrideProfile: true } : {}),
    })
  );
}
