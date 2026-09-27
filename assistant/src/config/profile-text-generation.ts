import { z } from "zod";

import { catalogModelSupportsText } from "../providers/model-catalog.js";

const ProfileReferenceSchema = z
  .object({
    profile: z.string().optional().catch(undefined),
  })
  .optional()
  .catch(undefined);
const TextGenerationProfileSchema = z.object({
  provider: z.string().optional().catch(undefined),
  model: z.string().optional().catch(undefined),
  mix: z.array(ProfileReferenceSchema).optional().catch(undefined),
});

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
  const parsed = TextGenerationProfileSchema.safeParse(entry);
  if (!parsed.success) {
    return true;
  }
  if (parsed.data.mix && parsed.data.mix.length > 0) {
    return parsed.data.mix.every((arm) => {
      const name = arm?.profile;
      if (name === undefined) {
        return true;
      }
      const target = TextGenerationProfileSchema.safeParse(siblings[name]);
      if (!target.success) {
        return true;
      }
      return catalogModelSupportsText(target.data.provider, target.data.model);
    });
  }
  return catalogModelSupportsText(parsed.data.provider, parsed.data.model);
}

export function nonTextConversationProfileMessage(profileName: string): string {
  return `Profile "${profileName}" uses a model that returns structured answers rather than chat text, so it cannot be the conversation model.`;
}
