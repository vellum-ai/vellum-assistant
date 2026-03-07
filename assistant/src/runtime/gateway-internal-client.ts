import { getGatewayInternalBaseUrl } from "../config/env.js";
import { mintEdgeRelayToken } from "./auth/token-service.js";

export class GatewayRequestError extends Error {
  statusCode: number;
  gatewayError: string | undefined;

  constructor(
    message: string,
    statusCode: number,
    gatewayError: string | undefined,
  ) {
    super(message);
    this.name = "GatewayRequestError";
    this.statusCode = statusCode;
    this.gatewayError = gatewayError;
  }
}

/**
 * Parse a non-ok gateway response into a human-readable error message.
 * Matches the existing pattern in contact tools: try JSON parse, extract
 * `.error` string, fall back to raw body text, fall back to status code.
 */
async function parseErrorResponse(
  resp: Response,
): Promise<GatewayRequestError> {
  const body = await resp.text();
  let gatewayError: string | undefined;
  let message = `Gateway request failed (${resp.status})`;

  try {
    const parsed = JSON.parse(body) as {
      error?: string | { code?: string; message?: string };
    };
    if (parsed.error) {
      // Runtime httpError() returns { error: { code, message } } while
      // gateway returns { error: "string" }. Handle both formats.
      const errStr =
        typeof parsed.error === "string"
          ? parsed.error
          : (parsed.error.message ?? JSON.stringify(parsed.error));
      gatewayError = errStr;
      message = errStr;
    }
  } catch {
    if (body) message = body;
  }

  return new GatewayRequestError(message, resp.status, gatewayError);
}

export async function gatewayGet<T>(path: string): Promise<T> {
  const baseUrl = getGatewayInternalBaseUrl();
  const token = mintEdgeRelayToken();

  const resp = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  if (!resp.ok) {
    throw await parseErrorResponse(resp);
  }

  return (await resp.json()) as T;
}

export async function gatewayPost<T>(
  path: string,
  body: unknown,
): Promise<{ status: number; data: T }> {
  const baseUrl = getGatewayInternalBaseUrl();
  const token = mintEdgeRelayToken();

  const resp = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw await parseErrorResponse(resp);
  }

  const data = (await resp.json()) as T;
  return { status: resp.status, data };
}
