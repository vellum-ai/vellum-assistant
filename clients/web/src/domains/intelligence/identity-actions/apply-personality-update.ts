/**
 * Applies the personality page's slider choices to the assistant.
 *
 * Hosted Qwen steers from the persisted sidecar on the next chat turn,
 * so this path only needs to report success and let the page write the
 * dials. Other models still go through `runIdentityRewrite`: the five
 * 0-100 sliders become a system-message asking the assistant to rewrite
 * its own identity files in the matching voice.
 */

import { isHostedSteeringProfile } from "@/assistant/hosted-steering-profile";
import { buildPersonalityMessage } from "@/assistant/personality-rewrite";
import { resolveMainAgentProfile } from "@/assistant/resolve-main-agent-profile";
import { t } from "@/i18n";

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
 * Apply the personality. Resolves `true` when hosted Qwen can persist
 * sliders without a rewrite, or when a rewrite turn settled. Resolves
 * `false` on any failure; never throws.
 */
export async function applyPersonalityUpdate({
  assistantId,
  values,
  assistantName,
}: ApplyPersonalityUpdateOptions): Promise<boolean> {
  let hostedQwen = false;
  try {
    const profile = await resolveMainAgentProfile(assistantId);
    hostedQwen = isHostedSteeringProfile(profile?.provider, profile?.model);
  } catch {
    return false;
  }
  if (hostedQwen) {
    return true;
  }
  return runIdentityRewrite({
    assistantId,
    content: buildPersonalityMessage(values, undefined, assistantName),
    title: t("applyPersonalityUpdate.conversationTitle", {
      ns: "intelligence",
    }),
    context: "identity_personality_update",
  });
}
