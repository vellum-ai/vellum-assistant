/**
 * HTTP client for the CES stored-credential probe endpoint.
 *
 * Endpoint (served by `credential-executor/src/http/probe-routes.ts`):
 * - POST /v1/probes/model-access -> ProbeModelAccessResponse
 *
 * Auth: Bearer token from a caller-supplied config.
 */

import type {
  ProbeModelAccess,
  ProbeModelAccessResponse,
} from "@vellumai/service-contracts/credential-rpc";

import type { CesHttpLogger } from "./http-credentials.js";

/** Configuration for the CES HTTP probe client. */
export interface CesHttpProbeConfig {
  /** Base URL of the CES HTTP API (e.g. `http://ces-container:8090`). */
  baseUrl: string;
  /** Bearer token for authenticating with CES. */
  serviceToken: string;
}

/**
 * Probe timeout. Higher than the CES-side outbound probe budget so a slow
 * provider surfaces as CES's own `inconclusive` verdict rather than as a
 * client-side timeout with no detail.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Ask CES to call a provider's model-listing endpoint with a stored
 * credential. Returns null when CES is unreachable or answers with an error
 * status, which callers report as an undetermined probe.
 */
export async function probeModelAccessOverHttp(
  config: CesHttpProbeConfig,
  logger: CesHttpLogger,
  request: ProbeModelAccess,
): Promise<ProbeModelAccessResponse | null> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/v1/probes/model-access`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.serviceToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn(
        { status: response.status },
        "CES model-access probe returned an error status",
      );
      return null;
    }
    return (await response.json()) as ProbeModelAccessResponse;
  } catch (err) {
    logger.warn({ err }, "CES model-access probe request failed");
    return null;
  }
}
