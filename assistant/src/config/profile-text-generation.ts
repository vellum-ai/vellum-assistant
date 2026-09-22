import { catalogModelSupportsText } from "../providers/model-catalog.js";

/**
 * Whether a profile can back the conversation model (active profile or a
 * per-conversation pin). Mix arms are judged individually: a mix that can
 * land on a non-text model is not a conversation profile.
 *
 * Missing arms and unlisted models default to true so other validators
 * (existence, availability) own those failures.
 */
export function profileSupportsTextGeneration(
  entry: {
    provider?: unknown;
    model?: unknown;
    mix?: unknown;
  },
  siblings: Record<string, unknown>,
): boolean {
  const mix = entry.mix;
  if (Array.isArray(mix) && mix.length > 0) {
    return mix.every((arm) => {
      const name =
        arm !== null &&
        typeof arm === "object" &&
        "profile" in arm &&
        typeof arm.profile === "string"
          ? arm.profile
          : undefined;
      if (name === undefined) {
        return true;
      }
      const target = siblings[name];
      if (target === null || typeof target !== "object") {
        return true;
      }
      const nested = target as { provider?: unknown; model?: unknown };
      return catalogModelSupportsText(
        typeof nested.provider === "string" ? nested.provider : undefined,
        typeof nested.model === "string" ? nested.model : undefined,
      );
    });
  }
  return catalogModelSupportsText(
    typeof entry.provider === "string" ? entry.provider : undefined,
    typeof entry.model === "string" ? entry.model : undefined,
  );
}

export function nonTextConversationProfileMessage(profileName: string): string {
  return `Profile "${profileName}" uses a model that returns structured answers rather than chat text, so it cannot be the conversation model.`;
}
