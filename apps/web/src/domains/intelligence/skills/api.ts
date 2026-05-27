/**
 * Hand-written fetch wrappers for assistant skill endpoints.
 *
 * These endpoints are served by the assistant daemon via
 * RuntimeProxyWildcardView under /v1/assistants/{id}/skills/* and are not
 * part of the Django OpenAPI schema, so no generated HeyAPI hooks exist.
 */

import {
  ApiError,
  assertHasResponse,
  client,
  extractErrorMessage,
  SDK_BASE_OPTIONS,
} from "@/domains/intelligence/client";

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

function buildQuery(params: FetchSkillsParams): Record<string, string> {
  const query: Record<string, string> = {};
  if (params.includeCatalog) query.include = "catalog";
  if (params.origin) query.origin = params.origin;
  if (params.kind) query.kind = params.kind;
  if (params.query) query.q = params.query;
  if (params.category) query.category = params.category;
  return query;
}

export async function fetchSkills(
  assistantId: string,
  params: FetchSkillsParams = {},
): Promise<SkillsListResponse> {
  const { data, error, response } = await client.get<SkillsListResponse, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/skills/",
    path: { assistant_id: assistantId },
    query: buildQuery({ includeCatalog: true, ...params }),
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load skills.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load skills."),
    );
  }
  return data ?? { skills: [] };
}

export interface InstallSkillResponse {
  ok: boolean;
  skillId?: string;
}

export async function installSkill(
  assistantId: string,
  slug: string,
  version?: string,
): Promise<InstallSkillResponse> {
  const { data, error, response } = await client.post<InstallSkillResponse, unknown>({
    ...SDK_BASE_OPTIONS,
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
  const { error, response } = await client.delete<unknown, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/skills/{skill_id}",
    path: { assistant_id: assistantId, skill_id: skillId },
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
  const { data, error, response } = await client.get<
    { skill: SkillInfo } | SkillInfo,
    unknown
  >({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/skills/{skill_id}",
    path: { assistant_id: assistantId, skill_id: skillId },
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
  if ("skill" in data) return (data as { skill: SkillInfo }).skill;
  return data as SkillInfo;
}

export async function fetchSkillFiles(
  assistantId: string,
  skillId: string,
): Promise<SkillFilesResponse | null> {
  const { data, error, response } = await client.get<SkillFilesResponse, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/skills/{skill_id}/files",
    path: { assistant_id: assistantId, skill_id: skillId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load skill files.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load skill files."),
    );
  }
  return data ?? null;
}

export async function fetchSkillFileContent(
  assistantId: string,
  skillId: string,
  path: string,
): Promise<SkillFileContentResponse | null> {
  const { data, error, response } = await client.get<
    SkillFileContentResponse,
    unknown
  >({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/skills/{skill_id}/files/content",
    path: { assistant_id: assistantId, skill_id: skillId },
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
  return data ?? null;
}
