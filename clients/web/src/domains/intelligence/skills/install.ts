/**
 * Install a skill by slug.
 */

import { skillsInstallPost } from "@/generated/daemon/sdk.gen";
import type { SkillsInstallPostResponse } from "@/generated/daemon/types.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

export async function installSkill(
  assistantId: string,
  slug: string,
  version?: string,
): Promise<SkillsInstallPostResponse> {
  const { data, error, response } = await skillsInstallPost({
    path: { assistant_id: assistantId },
    body: version ? { slug, version } : { slug },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to install skill.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to install skill."),
    );
  }
  return data ?? { ok: true };
}
