import { session, type WebRequestFilter } from "electron";

import { isAllowedOrigin, type AllowedOrigin } from "./app-origin";

export interface PairedGatewayRequestGuardOptions {
  appOrigin: AllowedOrigin;
  resolveAllowedOrigin: () => AllowedOrigin;
}

const createPairedGatewayRequestFilter = (
  appOrigin: AllowedOrigin,
): WebRequestFilter => ({
  urls: [
    `${appOrigin.protocol}//${appOrigin.host}/assistant/__gateway-paired/*`,
    `${appOrigin.protocol}//${appOrigin.host}/__gateway-paired/*`,
  ],
});

/**
 * Restrict the packaged app's paired gateway proxy to requests initiated by a
 * trusted renderer frame. Electron custom protocol requests omit Origin,
 * Referer, and Fetch Metadata headers, while WebRequest retains the requesting
 * frame's browser-controlled origin.
 */
export function installPairedGatewayRequestGuard({
  appOrigin,
  resolveAllowedOrigin,
}: PairedGatewayRequestGuardOptions): () => void {
  const webRequest = session.defaultSession.webRequest;
  const filter = createPairedGatewayRequestFilter(appOrigin);
  webRequest.onBeforeRequest(filter, (details, callback) => {
    callback({
      cancel: !isAllowedOrigin(details.frame?.origin, resolveAllowedOrigin()),
    });
  });

  return () => {
    webRequest.onBeforeRequest(filter, null);
  };
}
