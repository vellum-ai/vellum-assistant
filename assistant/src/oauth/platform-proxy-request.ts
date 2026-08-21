import type { VellumPlatformClient } from "../platform/client.js";
import { BackendError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import { getHttpRetryDelay, isRetryableStatus, sleep } from "../util/retry.js";
import type {
  OAuthConnectionRequest,
  OAuthConnectionResponse,
} from "./connection.js";
import {
  CredentialRequiredError,
  InsufficientBalanceError,
  ProviderUnreachableError,
} from "./platform-proxy-errors.js";

const log = getLogger("platform-oauth-connection");
const MAX_RETRIES = 3;

export function buildPlatformProxyPath(
  assistantId: string,
  connectionId: string,
): string {
  return `/v1/assistants/${assistantId}/external-provider-proxy/${connectionId}/`;
}

export function buildPlatformProxyEnvelope(
  req: OAuthConnectionRequest,
  fallbackBaseUrl?: string,
): {
  request: {
    method: string;
    path: string;
    query: Record<string, string | string[]>;
    headers: Record<string, string>;
    body: unknown;
    base_url?: string;
  };
} {
  const baseUrl = req.baseUrl ?? fallbackBaseUrl;
  return {
    request: {
      method: req.method,
      path: req.path,
      query: req.query ?? {},
      headers: req.headers ?? {},
      body: req.body ?? null,
      ...(baseUrl ? { base_url: baseUrl } : {}),
    },
  };
}

/**
 * POST an already-built envelope at the platform external-provider proxy.
 * Used by the daemon connection and by the CLI after `prepare_only`.
 */
export async function executePlatformProxyRequest(
  client: VellumPlatformClient,
  proxyPath: string,
  envelope: ReturnType<typeof buildPlatformProxyEnvelope>,
  signal?: AbortSignal,
): Promise<OAuthConnectionResponse> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await client.fetch(proxyPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(envelope),
      signal,
    });

    if (response.status === 402) {
      throw new InsufficientBalanceError();
    }

    if (response.status === 424) {
      throw new CredentialRequiredError();
    }

    if (
      !response.ok &&
      isRetryableStatus(response.status) &&
      attempt < MAX_RETRIES
    ) {
      log.warn(
        { status: response.status, attempt, provider: "platform-proxy" },
        `Retryable status ${response.status} from platform proxy (attempt ${attempt + 1}/${MAX_RETRIES + 1})`,
      );
      await sleep(getHttpRetryDelay(response, attempt));
      continue;
    }

    if (response.status === 502) {
      const detail = await response.text().catch(() => "");
      throw new ProviderUnreachableError(
        `The external service provider is temporarily unreachable (HTTP 502).${detail ? ` Detail: ${detail}` : ""} This may be a transient issue — retry after a brief pause.`,
      );
    }

    if (!response.ok) {
      throw new BackendError(
        `Platform proxy returned unexpected status ${response.status}`,
      );
    }

    const json = (await response.json()) as {
      status: number;
      headers: Record<string, string>;
      body: unknown;
    };

    return {
      status: json.status,
      headers: json.headers,
      body: json.body,
    };
  }

  throw new BackendError("Platform proxy request failed after retries");
}
