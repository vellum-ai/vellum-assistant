import { getGatewayInternalBaseUrl } from "../config/env.js";
import {
  initAuthSigningKey,
  isSigningKeyInitialized,
  loadOrCreateSigningKey,
  mintEdgeRelayToken,
} from "../runtime/auth/token-service.js";

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function toQueryString(
  params: Record<string, string | undefined>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

function getGatewayToken(): string {
  const existing = process.env.GATEWAY_AUTH_TOKEN?.trim();
  if (existing) return existing;

  if (!isSigningKeyInitialized()) {
    initAuthSigningKey(loadOrCreateSigningKey());
  }

  return mintEdgeRelayToken();
}

// CLI-specific gateway helper — uses GATEWAY_AUTH_TOKEN env var for out-of-process
// access. See runtime/gateway-internal-client.ts for daemon-internal usage which
// mints fresh tokens.
export async function gatewayGet(path: string): Promise<unknown> {
  const gatewayBase = getGatewayInternalBaseUrl();
  const token = getGatewayToken();

  const response = await fetch(`${gatewayBase}${path}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  const rawBody = await response.text();
  let parsed: unknown = { ok: false, error: rawBody };

  if (rawBody.length > 0) {
    try {
      parsed = JSON.parse(rawBody) as unknown;
    } catch {
      parsed = { ok: false, error: rawBody };
    }
  }

  if (!response.ok) {
    const message =
      typeof parsed === "object" && parsed && "error" in parsed
        ? String((parsed as { error?: unknown }).error)
        : `Gateway request failed (${response.status})`;
    throw new Error(`${message} [${response.status}]`);
  }

  return parsed;
}

export async function gatewayPost(
  path: string,
  body: unknown,
): Promise<unknown> {
  const gatewayBase = getGatewayInternalBaseUrl();
  const token = getGatewayToken();

  const response = await fetch(`${gatewayBase}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const rawBody = await response.text();
  let parsed: unknown = { ok: false, error: rawBody };

  if (rawBody.length > 0) {
    try {
      parsed = JSON.parse(rawBody) as unknown;
    } catch {
      parsed = { ok: false, error: rawBody };
    }
  }

  if (!response.ok) {
    const message =
      typeof parsed === "object" && parsed && "error" in parsed
        ? String((parsed as { error?: unknown }).error)
        : `Gateway request failed (${response.status})`;
    throw new Error(`${message} [${response.status}]`);
  }

  return parsed;
}
