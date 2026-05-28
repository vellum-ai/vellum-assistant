/**
 * Publish an app to Vercel and enrich the response with publish-status data.
 *
 * When the publish endpoint returns `success: true` but omits `publicUrl`,
 * performs a best-effort follow-up call to the publish-status endpoint to
 * retrieve the deployed URL and deployment ID. This enrichment is
 * transparent to callers — the returned result always has the most
 * complete data available.
 */

import {
  appsByIdPublishPost,
  appsByIdPublishstatusGet,
} from "@/generated/daemon/sdk.gen";
import type { AppsByIdPublishPostResponse } from "@/generated/daemon/types.gen";

export async function publishApp(
  assistantId: string,
  appId: string,
): Promise<AppsByIdPublishPostResponse> {
  const { data: result } = await appsByIdPublishPost({
    path: { assistant_id: assistantId, id: appId },
    throwOnError: true,
  });

  if (result.success && !result.publicUrl) {
    try {
      const { data: status } = await appsByIdPublishstatusGet({
        path: { assistant_id: assistantId, id: appId },
        throwOnError: true,
      });
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
