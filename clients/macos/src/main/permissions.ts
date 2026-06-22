import {
  session,
  type MediaAccessPermissionRequest,
  type PermissionCheckHandlerHandlerDetails,
  type Session,
} from "electron";

import { isAllowedOrigin, resolveAllowedOrigin } from "./app-origin";

type PermissionRequestName = Parameters<
  NonNullable<
    Parameters<typeof session.defaultSession.setPermissionRequestHandler>[0]
  >
>[1];

type PermissionCheckName = Parameters<
  NonNullable<
    Parameters<typeof session.defaultSession.setPermissionCheckHandler>[0]
  >
>[1];

const isTrustedRendererOrigin = (
  origin: string | URL | null | undefined,
): boolean => isAllowedOrigin(origin, resolveAllowedOrigin());

const isAudioOnlyMediaRequest = (
  details: Pick<MediaAccessPermissionRequest, "mediaTypes">,
): boolean => {
  const mediaTypes = details.mediaTypes ?? [];
  return mediaTypes.length > 0 && mediaTypes.every((type) => type === "audio");
};

/**
 * Permission requests are denied by default. Voice input needs audio capture
 * and clipboard write is needed for copy-to-clipboard buttons, but the
 * renderer should not gain camera, notification, or arbitrary web-platform
 * permissions through the shared default session.
 */
export const shouldGrantPermissionRequest = (
  permission: PermissionRequestName,
  details: Pick<MediaAccessPermissionRequest, "mediaTypes" | "securityOrigin">,
  fallbackOrigin?: string,
): boolean => {
  const origin = details.securityOrigin ?? fallbackOrigin;

  if (permission === "clipboard-sanitized-write") {
    return isTrustedRendererOrigin(origin);
  }

  return (
    permission === "media" &&
    isAudioOnlyMediaRequest(details) &&
    isTrustedRendererOrigin(origin)
  );
};

/**
 * Chromium often performs a permission check before issuing the request. Keep
 * this in sync with the request handler so `getUserMedia({ audio: true })` and
 * `navigator.clipboard.writeText()` can proceed while unrelated permission
 * checks still fail closed.
 */
export const shouldGrantPermissionCheck = (
  permission: PermissionCheckName,
  requestingOrigin: string,
  details: Pick<
    PermissionCheckHandlerHandlerDetails,
    "mediaType" | "securityOrigin" | "requestingUrl"
  >,
): boolean => {
  const isTrusted =
    isTrustedRendererOrigin(details.securityOrigin) ||
    isTrustedRendererOrigin(requestingOrigin) ||
    isTrustedRendererOrigin(details.requestingUrl);

  if (permission === "clipboard-sanitized-write") {
    return isTrusted;
  }

  return permission === "media" && details.mediaType === "audio" && isTrusted;
};

export const denyAllPermissions = (targetSession: Session): void => {
  targetSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => {
      callback(false);
    },
  );
  targetSession.setPermissionCheckHandler(() => false);
};

export const installPermissionHandler = (): void => {
  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin, details) =>
      shouldGrantPermissionCheck(permission, requestingOrigin, details),
  );

  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      callback(
        shouldGrantPermissionRequest(
          permission,
          details as MediaAccessPermissionRequest,
          webContents.getURL(),
        ),
      );
    },
  );
};
