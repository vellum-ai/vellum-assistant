import { VellumPlatformClient } from "../../platform/client.js";

export type ManagedSearchProxyProvider = "brave";

export interface ManagedSearchProxyRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ManagedSearchProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export type ManagedSearchProxyResult =
  | ({ ok: true } & ManagedSearchProxyResponse)
  | {
      ok: false;
      kind: "unavailable";
      message: string;
    }
  | {
      ok: false;
      kind: "platform-error";
      status: number;
      headers: Record<string, string>;
      body: unknown;
      message: string;
    }
  | {
      ok: false;
      kind: "invalid-response";
      body: unknown;
      message: string;
    };

interface ManagedSearchProxyEnvelope {
  request: {
    method: string;
    path: string;
    query: Record<string, string>;
    headers: Record<string, string>;
    body: unknown;
  };
}

export async function callManagedSearchProxy(
  provider: ManagedSearchProxyProvider,
  request: ManagedSearchProxyRequest,
  signal?: AbortSignal,
): Promise<ManagedSearchProxyResult> {
  const client = await VellumPlatformClient.create();
  if (!client) {
    return {
      ok: false,
      kind: "unavailable",
      message: "Managed search proxy is unavailable in this environment.",
    };
  }

  if (!client.platformAssistantId) {
    return {
      ok: false,
      kind: "unavailable",
      message:
        "Managed search proxy is unavailable: platform assistant ID is missing.",
    };
  }

  const path = `/v1/assistants/${encodeURIComponent(
    client.platformAssistantId,
  )}/managed-search-proxy/${encodeURIComponent(provider)}/`;

  const envelope: ManagedSearchProxyEnvelope = {
    request: {
      method: request.method,
      path: request.path,
      query: request.query ?? {},
      headers: request.headers ?? {},
      body: request.body ?? null,
    },
  };

  const response = await client.fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(envelope),
    signal,
  });

  if (!response.ok) {
    const body = await readResponseBody(response);
    return {
      ok: false,
      kind: "platform-error",
      status: response.status,
      headers: responseHeadersToRecord(response.headers),
      body,
      message: platformErrorMessage(response.status, body),
    };
  }

  const body = await readResponseBody(response);
  if (!isManagedSearchProxyResponse(body)) {
    return {
      ok: false,
      kind: "invalid-response",
      body,
      message: "Managed search proxy returned an invalid response envelope.",
    };
  }

  return {
    ok: true,
    status: body.status,
    headers: body.headers,
    body: body.body,
  };
}

function isManagedSearchProxyResponse(
  value: unknown,
): value is ManagedSearchProxyResponse {
  if (!isRecord(value)) return false;
  if (typeof value.status !== "number") return false;
  if (!isStringRecord(value.headers)) return false;
  return "body" in value;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) return null;

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return text;
}

function responseHeadersToRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

function platformErrorMessage(status: number, body: unknown): string {
  const detail = extractErrorDetail(body);
  if (detail) {
    return `Managed search proxy returned status ${status}: ${detail}`;
  }
  return `Managed search proxy returned status ${status}.`;
}

function extractErrorDetail(body: unknown): string | undefined {
  if (typeof body === "string") return body || undefined;
  if (!isRecord(body)) return undefined;

  for (const key of ["detail", "error", "message"]) {
    const value = body[key];
    if (typeof value === "string" && value) return value;
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}
