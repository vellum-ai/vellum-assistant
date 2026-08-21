import { session, type WebRequestFilter } from "electron";

import { APP_HOST, APP_PROTOCOL } from "./app-config";
import {
  isAllowedOrigin,
  resolveAllowedOrigin,
  type AllowedOrigin,
} from "./app-origin.client";

const PAIRED_GATEWAY_REQUEST_FILTER: WebRequestFilter = {
  urls: [
    `${APP_PROTOCOL}://${APP_HOST}/assistant/__gateway-paired/*`,
    `${APP_PROTOCOL}://${APP_HOST}/__gateway-paired/*`,
  ],
};

/**
 * Restrict the packaged app's paired gateway proxy to requests initiated by a
 * trusted renderer frame. Electron custom protocol requests omit Origin,
 * Referer, and Fetch Metadata headers, while WebRequest retains the requesting
 * frame's browser-controlled origin.
 */
export function installPairedGatewayRequestGuard(
  allowedOrigin: AllowedOrigin = resolveAllowedOrigin(),
): () => void {
  const webRequest = session.defaultSession.webRequest;
  webRequest.onBeforeRequest(
    PAIRED_GATEWAY_REQUEST_FILTER,
    (details, callback) => {
      callback({
        cancel: !isAllowedOrigin(details.frame?.origin, allowedOrigin),
      });
    },
  );

  return () => {
    webRequest.onBeforeRequest(PAIRED_GATEWAY_REQUEST_FILTER, null);
  };
}
