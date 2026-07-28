/**
 * Applies the personality page's slider choices to the assistant.
 *
 * Reuses onboarding's `buildPersonalityMessage` — the five 0–100 trait
 * sliders become a system-message asking the assistant to rewrite its own
 * identity files in the matching voice — but runs it through
 * `runIdentityRewrite` so the page can show a saving state and report
 * success/failure, unlike onboarding's fire-and-forget flow.
 */

import { buildPersonalityMessage } from "@/assistant/personality-rewrite";

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
 * Apply the personality on a throwaway side conversation. Resolves `true`
 * once the rewrite turn settled, `false` on any failure; never throws.
 */
export async function applyPersonalityUpdate({
  assistantId,
  values,
  assistantName,
}: ApplyPersonalityUpdateOptions): Promise<boolean> {
  return runIdentityRewrite({
    assistantId,
    content: buildPersonalityMessage(values, undefined, assistantName),
    title: "Updating personality",
    context: "identity_personality_update",
  });
}
