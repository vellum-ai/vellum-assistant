/**
 * Install a skill by slug.
 */

import { skillsInstallPost } from "@/generated/daemon/sdk.gen";
import type { SkillsInstallPostResponse } from "@/generated/daemon/types.gen";
import { t } from "@/i18n";
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
  const failureMessage = t("installSkill.failureMessage", {
    ns: "intelligence",
  });
  assertHasResponse(response, error, failureMessage);
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, failureMessage),
    );
  }
  return data ?? { ok: true };
}
