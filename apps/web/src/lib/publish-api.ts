/**
 * Vercel publish / unpublish operations via the generated daemon SDK.
 *
 * Types are re-exported from the generated SDK so consumers don't need
 * to reach into `@/generated/daemon/` directly.
 */

import {
  appsByIdPublishPost,
  appsByIdPublishstatusGet,
  appsByIdUnpublishPost,
  integrationsVercelConfigGet,
  integrationsVercelConfigPost,
} from "@/generated/daemon/sdk.gen";
import type {
  AppsByIdPublishPostResponse,
  AppsByIdPublishstatusGetResponse,
  AppsByIdUnpublishPostResponse,
  IntegrationsVercelConfigGetResponse,
} from "@/generated/daemon/types.gen";
import { ApiError, assertHasResponse, extractErrorMessage } from "@/lib/api-errors";

// ---------------------------------------------------------------------------
// Types — re-exported from generated daemon SDK
// ---------------------------------------------------------------------------

export type VercelConfigResponse = IntegrationsVercelConfigGetResponse;

export type PublishPageResponse = AppsByIdPublishPostResponse;

export type UnpublishPageResponse = AppsByIdUnpublishPostResponse;

export type PublishStatusResponse = AppsByIdPublishstatusGetResponse;

export function isCredentialError(result: PublishPageResponse): boolean {
  return (
    result.errorCode === "credentials_missing" ||
    !!result.error?.includes("not allowed to use credential") ||
    !!result.error?.includes("domain restrictions") ||
    !!result.error?.includes("Credential use failed")
  );
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function getVercelConfig(
  assistantId: string,
): Promise<VercelConfigResponse> {
  const { data, error, response } = await integrationsVercelConfigGet({
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to get Vercel config.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to get Vercel config.");
    throw new ApiError(response.status, msg);
  }
  return data!;
}

export async function setVercelToken(
  assistantId: string,
  apiToken: string,
): Promise<void> {
  const { error, response } = await integrationsVercelConfigPost({
    path: { assistant_id: assistantId },
    body: { action: "set", apiToken },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to set Vercel token.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to set Vercel token.");
    throw new ApiError(response.status, msg);
  }
}

export async function publishApp(
  assistantId: string,
  appId: string,
): Promise<PublishPageResponse> {
  const { data, error, response } = await appsByIdPublishPost({
    path: { assistant_id: assistantId, id: appId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to publish app.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to publish app.");
    throw new ApiError(response.status, msg);
  }
  const result = { ...data! };

  if (result.success && !result.publicUrl) {
    try {
      const status = await getPublishStatus(assistantId, appId);
      if (status.publicUrl) {
        result.publicUrl = status.publicUrl;
      }
      if (status.deploymentId && !result.deploymentId) {
        result.deploymentId = status.deploymentId;
      }
    } catch {
      // Best-effort — still return the publish result even if status lookup fails
    }
  }

  return result;
}

export async function unpublishApp(
  assistantId: string,
  appId: string,
): Promise<UnpublishPageResponse> {
  const { data, error, response } = await appsByIdUnpublishPost({
    path: { assistant_id: assistantId, id: appId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to unpublish app.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to unpublish app.");
    throw new ApiError(response.status, msg);
  }
  return data!;
}

export async function getPublishStatus(
  assistantId: string,
  appId: string,
): Promise<PublishStatusResponse> {
  const { data, error, response } = await appsByIdPublishstatusGet({
    path: { assistant_id: assistantId, id: appId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to get publish status.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to get publish status.");
    throw new ApiError(response.status, msg);
  }
  return data!;
}
