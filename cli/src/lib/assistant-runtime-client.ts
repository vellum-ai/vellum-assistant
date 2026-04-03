/**
 * HTTP client for communicating with a running assistant's runtime API.
 *
 * This module provides typed helpers for the gateway HTTP endpoints
 * (e.g. `/v1/assistants/:id/messages/`). It is intentionally transport-
 * agnostic — no SSE, no websocket — so it can be used from both the CLI
 * and external test harnesses.
 */

export interface SendMessageResponse {
  accepted: boolean;
  messageId: string;
}

export interface AssistantRuntimeClientOptions {
  /** Base URL of the assistant gateway (e.g. `http://localhost:7830`). */
  runtimeUrl: string;
  /** The assistant's ID (used in URL paths and as default conversation key). */
  assistantId: string;
  /** Optional bearer token for authenticated requests. */
  bearerToken?: string;
  /** Timeout in milliseconds for the HTTP request (default: 30_000). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Low-level request helper. Builds the full URL, attaches JSON headers
 * and an optional bearer token, and handles non-2xx responses.
 */
async function runtimeRequest<T>(
  baseUrl: string,
  assistantId: string,
  path: string,
  init?: RequestInit,
  bearerToken?: string,
): Promise<T> {
  const url = `${baseUrl}/v1/assistants/${assistantId}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${body || response.statusText}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

/**
 * Send a message to a running assistant and return the API response.
 *
 * POST /v1/assistants/:assistantId/messages/
 */
export async function sendMessage(
  options: AssistantRuntimeClientOptions,
  content: string,
): Promise<SendMessageResponse> {
  const { runtimeUrl, assistantId, bearerToken, timeoutMs } = options;
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    return await runtimeRequest<SendMessageResponse>(
      runtimeUrl,
      assistantId,
      "/messages/",
      {
        method: "POST",
        body: JSON.stringify({ conversationKey: assistantId, content }),
        signal: controller.signal,
      },
      bearerToken,
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Send timed out after ${timeout}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
