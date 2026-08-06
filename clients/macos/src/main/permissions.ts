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

/**
 * Audio and video are both capture the product asks for: the microphone for
 * voice input, and the camera for the voice room's viewfinder, which lets a
 * caller show the assistant what they are looking at mid-call.
 *
 * Still an allowlist rather than a blanket grant of `media`. Anything that
 * turns up in `mediaTypes` other than these two is a capture surface nobody
 * has designed for, and it fails closed.
 */
const isCaptureMediaRequest = (
  details: Pick<MediaAccessPermissionRequest, "mediaTypes">,
): boolean => {
  const mediaTypes = details.mediaTypes ?? [];
  return (
    mediaTypes.length > 0 &&
    mediaTypes.every((type) => type === "audio" || type === "video")
  );
};

/**
 * Permission requests are denied by default. Voice input needs audio capture,
 * the voice room's camera needs video capture, and clipboard write is needed
 * for copy-to-clipboard buttons, but the renderer should not gain
 * notification or arbitrary web-platform permissions through the shared
 * default session.
 *
 * Granting video here is what lets the camera button raise the macOS prompt at
 * the moment it is pressed. Denying it does not fall back to asking: Chromium
 * refuses `getUserMedia` before macOS is ever consulted, so the button reports
 * a permission failure the user was never given a chance to answer. The two
 * pieces the OS side needs, `NSCameraUsageDescription` and
 * `com.apple.security.device.camera`, are already declared in
 * `electron-builder.config.cjs` and `scripts/entitlements/app.plist`.
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
    isCaptureMediaRequest(details) &&
    isTrustedRendererOrigin(origin)
  );
};

/**
 * Chromium often performs a permission check before issuing the request. Keep
 * this in sync with the request handler so `getUserMedia({ audio: true })`,
 * `getUserMedia({ video: … })` and `navigator.clipboard.writeText()` can
 * proceed while unrelated permission checks still fail closed.
 *
 * Out of sync in the deny direction is the silent failure: the check runs
 * first, so a `video` request refused here never reaches the request handler
 * above and the camera fails with no prompt.
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

  return (
    permission === "media" &&
    (details.mediaType === "audio" || details.mediaType === "video") &&
    isTrusted
  );
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
