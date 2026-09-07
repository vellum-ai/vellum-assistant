/**
 * Applies the personality page's slider choices to the assistant.
 *
 * Hosted Qwen on an assistant that consumes the sidecar steers from
 * `data/personality-sliders.json` on the next chat turn, so this path
 * persists the dials and skips the identity rewrite. Older assistants
 * and every other model still go through `runIdentityRewrite`: the
 * five 0-100 sliders become a system-message asking the assistant to
 * rewrite its own identity files in the matching voice.
 *
 * Success is the sidecar write. A rewrite that settles but fails to
 * persist the dials is reported as failure.
 */

import { isHostedSteeringProfile } from "@/assistant/hosted-steering-profile";
import { buildPersonalityMessage } from "@/assistant/personality-rewrite";
import {
  completeSliderValues,
  savePersonalitySliders,
} from "@/assistant/personality-sliders";
import { resolveMainAgentProfile } from "@/assistant/resolve-main-agent-profile";
import { t } from "@/i18n";
import { assistantSupportsHostedQwenPersonalitySteering } from "@/lib/backwards-compat/hosted-qwen-personality-steering";

import { runIdentityRewrite } from "./run-identity-rewrite";

export interface ApplyPersonalityUpdateOptions {
  assistantId: string;
  /** The five slider values, keyed by axis id (see `PERSONALITY_AXES`). */
  values: Record<string, number>;
  /**
   * The assistant's current name, pinned through the rewrite so the
   * personality change never renames it.
   */
  assistantName?: string;
}

/**
 * Apply the personality. Resolves `true` only after the sidecar write
 * succeeds (and, on the rewrite path, after the rewrite turn settled).
 * Resolves `false` on any failure; never throws.
 */
export async function applyPersonalityUpdate({
  assistantId,
  values,
  assistantName,
}: ApplyPersonalityUpdateOptions): Promise<boolean> {
  const complete = completeSliderValues(values);
  let skipRewrite = false;
  try {
    const profile = await resolveMainAgentProfile(assistantId);
    skipRewrite =
      isHostedSteeringProfile(profile?.provider, profile?.model) &&
      (await assistantSupportsHostedQwenPersonalitySteering(assistantId));
  } catch {
    return false;
  }
  if (!skipRewrite) {
    const rewritten = await runIdentityRewrite({
      assistantId,
      content: buildPersonalityMessage(complete, undefined, assistantName),
      title: t("applyPersonalityUpdate.conversationTitle", {
        ns: "intelligence",
      }),
      context: "identity_personality_update",
    });
    if (!rewritten) {
      return false;
    }
  }
  return savePersonalitySliders(assistantId, complete);
}
