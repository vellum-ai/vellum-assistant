/**
 * Fetch wrappers for assistant skill endpoints.
 *
 * Uses the daemon SDK for routing — all calls go through daemonClient,
 * which forwards unconditionally to the self-hosted gateway.
 *
 * Hand-written types (`./types`) are kept as the domain interface because
 * the generated `SkillsGetResponse` uses a discriminated union by origin
 * that would require updating every consumer. Follow-up: adopt generated
 * types in the component layer.
 */

import { client as daemonClient } from "@/generated/daemon/client.gen";
import {
  skillsByIdDelete,
  skillsByIdFilesContentGet,
  skillsByIdFilesGet,
  skillsByIdGet,
  skillsGet,
} from "@/generated/daemon/sdk.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

import type {
  SkillFileContentResponse,
  SkillFilesResponse,
  SkillInfo,
  SkillsListResponse,
} from "./types";

export { ApiError };

export interface FetchSkillsParams {
  origin?: string;
  kind?: "installed" | "available" | string;
  query?: string;
  category?: string;
  includeCatalog?: boolean;
}

export async function fetchSkills(
  assistantId: string,
  params: FetchSkillsParams = {},
): Promise<SkillsListResponse> {
  const merged = { includeCatalog: true, ...params };
  const { data, error, response } = await skillsGet({
    path: { assistant_id: assistantId },
    query: {
      include: merged.includeCatalog ? "catalog" : undefined,
      origin: merged.origin,
      kind: merged.kind,
      q: merged.query,
      category: merged.category,
    },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load skills.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load skills."),
    );
  }
  return (data as SkillsListResponse) ?? { skills: [] };
}

export interface InstallSkillResponse {
  ok: boolean;
  skillId?: string;
}

/**
 * Install a skill by slug.
 *
 * Uses the daemon client directly because the generated
 * `skillsInstallPost` requires body fields (`url`, `spec`) that the
 * daemon resolves server-side from the slug.
 */
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

export async function uninstallSkill(
  assistantId: string,
  skillId: string,
): Promise<void> {
  const { error, response } = await skillsByIdDelete({
    path: { assistant_id: assistantId, id: skillId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to uninstall skill.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to uninstall skill."),
    );
  }
}

export async function fetchSkillDetail(
  assistantId: string,
  skillId: string,
): Promise<SkillInfo | null> {
  const { data, error, response } = await skillsByIdGet({
    path: { assistant_id: assistantId, id: skillId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load skill detail.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load skill detail."),
    );
  }
  if (!data) return null;
  return data.skill as SkillInfo;
}

export async function fetchSkillFiles(
  assistantId: string,
  skillId: string,
): Promise<SkillFilesResponse | null> {
  const { data, error, response } = await skillsByIdFilesGet({
    path: { assistant_id: assistantId, id: skillId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load skill files.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load skill files."),
    );
  }
  return (data as SkillFilesResponse) ?? null;
}

export async function fetchSkillFileContent(
  assistantId: string,
  skillId: string,
  path: string,
): Promise<SkillFileContentResponse | null> {
  const { data, error, response } = await skillsByIdFilesContentGet({
    path: { assistant_id: assistantId, id: skillId },
    query: { path },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load file content.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load file content."),
    );
  }
  return (data as SkillFileContentResponse) ?? null;
}
