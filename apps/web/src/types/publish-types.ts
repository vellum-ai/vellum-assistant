import type {
  AppsByIdPublishPostResponse,
  AppsByIdPublishstatusGetResponse,
  AppsByIdUnpublishPostResponse,
  IntegrationsVercelConfigGetResponse,
} from "@/generated/daemon/types.gen";

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
