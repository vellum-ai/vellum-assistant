// App management, gallery, publishing, and sharing types.

import type { GalleryManifest } from "../../gallery/gallery-manifest.js";

// === Client → Server ===

export interface AppDataRequest {
  type: "app_data_request";
  surfaceId: string;
  callId: string;
  method: "query" | "create" | "update" | "delete";
  appId: string;
  recordId?: string;
  data?: Record<string, unknown>;
}

export interface AppsListRequest {
  type: "apps_list";
}

export interface HomeBaseGetRequest {
  type: "home_base_get";
  /** If true, daemon ensures a durable Home Base link exists before responding. */
  ensureLinked?: boolean;
}

export interface AppOpenRequest {
  type: "app_open_request";
  appId: string;
}

export interface SharedAppsListRequest {
  type: "shared_apps_list";
}

export interface AppDeleteRequest {
  type: "app_delete";
  appId: string;
}

export interface SharedAppDeleteRequest {
  type: "shared_app_delete";
  uuid: string;
}

export interface ForkSharedAppRequest {
  type: "fork_shared_app";
  uuid: string;
}

export interface BundleAppRequest {
  type: "bundle_app";
  appId: string;
}

export interface AppUpdatePreviewRequest {
  type: "app_update_preview";
  appId: string;
  /** Base64-encoded PNG screenshot thumbnail. */
  preview: string;
}

export interface AppPreviewRequest {
  type: "app_preview_request";
  appId: string;
}

export interface OpenBundleRequest {
  type: "open_bundle";
  filePath: string;
}

export interface SignBundlePayloadResponse {
  type: "sign_bundle_payload_response";
  requestId: string;
  signature?: string;
  keyId?: string;
  publicKey?: string;
  error?: string;
}

export interface GetSigningIdentityResponse {
  type: "get_signing_identity_response";
  requestId: string;
  keyId?: string;
  publicKey?: string;
  error?: string;
}

export interface GalleryListRequest {
  type: "gallery_list";
}

export interface GalleryInstallRequest {
  type: "gallery_install";
  galleryAppId: string;
}

export interface AppHistoryRequest {
  type: "app_history_request";
  appId: string;
  limit?: number;
}

export interface AppDiffRequest {
  type: "app_diff_request";
  appId: string;
  fromCommit: string;
  toCommit?: string;
}

export interface AppFileAtVersionRequest {
  type: "app_file_at_version_request";
  appId: string;
  path: string;
  commitHash: string;
}

export interface AppRestoreRequest {
  type: "app_restore_request";
  appId: string;
  commitHash: string;
}

export interface ShareAppCloudRequest {
  type: "share_app_cloud";
  appId: string;
}

export interface ShareToSlackRequest {
  type: "share_to_slack";
  appId: string;
}

export interface PublishPageRequest {
  type: "publish_page";
  html: string;
  title?: string;
  appId?: string;
}

export interface UnpublishPageRequest {
  type: "unpublish_page";
  deploymentId: string;
}

// === Server → Client ===

export interface AppDataResponse {
  type: "app_data_response";
  surfaceId: string;
  callId: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

export interface AppUpdatePreviewResponse {
  type: "app_update_preview_response";
  success: boolean;
  appId: string;
}

export interface AppPreviewResponse {
  type: "app_preview_response";
  appId: string;
  preview?: string;
}

export interface AppsListResponse {
  type: "apps_list_response";
  apps: Array<{
    id: string;
    name: string;
    description?: string;
    icon?: string;
    preview?: string;
    createdAt: number;
    version?: string;
    contentId?: string;
  }>;
}

export interface HomeBaseGetResponse {
  type: "home_base_get_response";
  homeBase: {
    appId: string;
    source: string;
    starterTasks: string[];
    onboardingTasks: string[];
    preview: {
      title: string;
      subtitle: string;
      description: string;
      icon: string;
      metrics: Array<{ label: string; value: string }>;
    };
  } | null;
}

export interface SharedAppsListResponse {
  type: "shared_apps_list_response";
  apps: Array<{
    uuid: string;
    name: string;
    description?: string;
    icon?: string;
    preview?: string;
    entry: string;
    trustTier: string;
    signerDisplayName?: string;
    bundleSizeBytes: number;
    installedAt: string;
    version?: string;
    contentId?: string;
    updateAvailable?: boolean;
  }>;
}

export interface AppDeleteResponse {
  type: "app_delete_response";
  success: boolean;
}

export interface SharedAppDeleteResponse {
  type: "shared_app_delete_response";
  success: boolean;
}

export interface ForkSharedAppResponse {
  type: "fork_shared_app_response";
  success: boolean;
  appId?: string;
  name?: string;
  error?: string;
}

export interface BundleAppResponse {
  type: "bundle_app_response";
  bundlePath: string;
  /** Base64-encoded PNG of the generated app icon, if available. */
  iconImageBase64?: string;
  manifest: {
    format_version: number;
    name: string;
    description?: string;
    icon?: string;
    created_at: string;
    created_by: string;
    entry: string;
    capabilities: string[];
    version?: string;
    content_id?: string;
  };
}

export interface OpenBundleResponse {
  type: "open_bundle_response";
  manifest: {
    format_version: number;
    name: string;
    description?: string;
    icon?: string;
    created_at: string;
    created_by: string;
    entry: string;
    capabilities: string[];
  };
  scanResult: {
    passed: boolean;
    blocked: string[];
    warnings: string[];
  };
  signatureResult: {
    trustTier: "verified" | "signed" | "unsigned" | "tampered";
    signerKeyId?: string;
    signerDisplayName?: string;
    signerAccount?: string;
  };
  bundleSizeBytes: number;
}

export interface SignBundlePayloadRequest {
  type: "sign_bundle_payload";
  requestId: string;
  payload: string;
}

export interface GetSigningIdentityRequest {
  type: "get_signing_identity";
  requestId: string;
}

export interface ShareAppCloudResponse {
  type: "share_app_cloud_response";
  success: boolean;
  shareToken?: string;
  shareUrl?: string;
  error?: string;
}

export interface GalleryListResponse {
  type: "gallery_list_response";
  gallery: GalleryManifest;
}

export interface GalleryInstallResponse {
  type: "gallery_install_response";
  success: boolean;
  appId?: string;
  name?: string;
  error?: string;
}

export interface AppHistoryResponse {
  type: "app_history_response";
  appId: string;
  versions: Array<{
    commitHash: string;
    message: string;
    timestamp: number;
  }>;
}

export interface AppDiffResponse {
  type: "app_diff_response";
  appId: string;
  diff: string;
}

export interface AppFileAtVersionResponse {
  type: "app_file_at_version_response";
  appId: string;
  path: string;
  content: string;
}

export interface AppRestoreResponse {
  type: "app_restore_response";
  success: boolean;
  error?: string;
}

export interface ShareToSlackResponse {
  type: "share_to_slack_response";
  success: boolean;
  error?: string;
}

export interface PublishPageResponse {
  type: "publish_page_response";
  success: boolean;
  publicUrl?: string;
  deploymentId?: string;
  error?: string;
  errorCode?: string;
}

export interface UnpublishPageResponse {
  type: "unpublish_page_response";
  success: boolean;
  error?: string;
}

export interface AppFilesChanged {
  type: "app_files_changed";
  appId: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _AppsClientMessages =
  | AppDataRequest
  | AppsListRequest
  | HomeBaseGetRequest
  | AppOpenRequest
  | SharedAppsListRequest
  | AppDeleteRequest
  | SharedAppDeleteRequest
  | ForkSharedAppRequest
  | BundleAppRequest
  | OpenBundleRequest
  | SignBundlePayloadResponse
  | GetSigningIdentityResponse
  | GalleryListRequest
  | GalleryInstallRequest
  | AppHistoryRequest
  | AppDiffRequest
  | AppFileAtVersionRequest
  | AppRestoreRequest
  | ShareAppCloudRequest
  | ShareToSlackRequest
  | AppUpdatePreviewRequest
  | AppPreviewRequest
  | PublishPageRequest
  | UnpublishPageRequest;

export type _AppsServerMessages =
  | AppDataResponse
  | AppsListResponse
  | HomeBaseGetResponse
  | SharedAppsListResponse
  | AppDeleteResponse
  | SharedAppDeleteResponse
  | ForkSharedAppResponse
  | BundleAppResponse
  | OpenBundleResponse
  | SignBundlePayloadRequest
  | GetSigningIdentityRequest
  | ShareAppCloudResponse
  | GalleryListResponse
  | GalleryInstallResponse
  | AppHistoryResponse
  | AppDiffResponse
  | AppFileAtVersionResponse
  | AppRestoreResponse
  | ShareToSlackResponse
  | AppUpdatePreviewResponse
  | AppPreviewResponse
  | PublishPageResponse
  | UnpublishPageResponse
  | AppFilesChanged;
