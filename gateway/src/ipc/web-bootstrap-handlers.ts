/**
 * IPC-only bootstrap for browser remote ingress.
 *
 * The public tunnel must front the web edge, not the raw gateway. Keeping this
 * minting path on the gateway Unix socket means a misconfigured tunnel pointed
 * at the gateway port has no HTTP endpoint that can bootstrap browser auth.
 */

import { z } from "zod";

import {
  ensureVellumGuardianBinding,
  getExternalAssistantId,
  mintAndRecordDeviceBoundTokenPair,
} from "../auth/guardian-bootstrap.js";
import { getLogger } from "../logger.js";
import { getMergedFeatureFlags } from "./feature-flag-handlers.js";
import type { IpcRoute } from "./server.js";

const log = getLogger("web-bootstrap-ipc");

export const WEB_REMOTE_INGRESS_FLAG = "web-remote-ingress";

const MintWebPairingCredentialsParamsSchema = z.object({
  deviceId: z.string().trim().min(1).max(256),
  clientId: z.string().trim().max(128).optional(),
});

export interface WebPairingCredentials {
  assistantId: string;
  guardianPrincipalId: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  refreshAfter: string;
}

function isWebRemoteIngressEnabled(): boolean {
  return getMergedFeatureFlags()[WEB_REMOTE_INGRESS_FLAG] === true;
}

export async function mintWebPairingCredentials(
  params?: Record<string, unknown>,
): Promise<WebPairingCredentials> {
  const parsed = MintWebPairingCredentialsParamsSchema.parse(params);

  if (!isWebRemoteIngressEnabled()) {
    throw new Error(`${WEB_REMOTE_INGRESS_FLAG} feature flag is disabled`);
  }

  const guardianPrincipalId = await ensureVellumGuardianBinding();
  const pair = mintAndRecordDeviceBoundTokenPair({
    guardianPrincipalId,
    deviceId: parsed.deviceId,
    platform: "web",
  });

  log.info(
    {
      clientId: parsed.clientId,
      guardianPrincipalId,
    },
    "Minted web remote ingress pairing credentials via gateway IPC",
  );

  return {
    assistantId: getExternalAssistantId(),
    guardianPrincipalId,
    accessToken: pair.accessToken,
    accessTokenExpiresAt: new Date(pair.accessTokenExpiresAt).toISOString(),
    refreshToken: pair.refreshToken,
    refreshTokenExpiresAt: new Date(pair.refreshTokenExpiresAt).toISOString(),
    refreshAfter: new Date(pair.refreshAfter).toISOString(),
  };
}

export const webBootstrapRoutes: IpcRoute[] = [
  {
    method: "mint_web_pairing_credentials",
    schema: MintWebPairingCredentialsParamsSchema,
    handler: mintWebPairingCredentials,
  },
];
