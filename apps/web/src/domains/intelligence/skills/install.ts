/**
 * Install a skill by slug.
 *
 * Uses the daemon client directly because the generated
 * `skillsInstallPost` body schema requires `url` and `spec` — fields
 * the daemon resolves server-side from the slug. Until the OpenAPI
 * spec marks those fields optional, the generated mutation can't be
 * used for slug-only installs.
 */

import { client as daemonClient } from "@/generated/daemon/client.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

export interface InstallSkillResponse {
  ok: boolean;
  skillId?: string;
}

export async function installSkill(
  assistantId: string,
  slug: string,
  version?: string,
): Promise<InstallSkillResponse> {
  const { data, error, response } = await daemonClient.post<
    InstallSkillResponse,
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/skills/install",
    path: { assistant_id: assistantId },
    body: version ? { slug, version } : { slug },
    headers: { "Content-Type": "application/json" },
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
