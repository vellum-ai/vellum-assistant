/**
 * Save-time probe for connections with a custom base URL.
 *
 * A wrong base path (e.g. NVIDIA without `/v1`) otherwise stays invisible
 * until the first chat turn fails with an opaque provider 404. The probe
 * fires one minimal chat-completions request against the stored endpoint and
 * reports the outcome as a non-blocking hint. The save always succeeds.
 */

import { z } from "zod";

import { getLogger } from "../../util/logger.js";
import type { Auth, ConnectionModel } from "./auth.js";
import { resolveAuth } from "./resolve-auth.js";

const log = getLogger("inference-endpoint-probe");

/**
 * Bound on every save-path probe (this endpoint probe and the profile probe)
 * so a dead host can't hang a save. Matches the API-key validation timeout.
 */
export const PROBE_TIMEOUT_MS = 10_000;

export const EndpointCheckSchema = z
  .object({
    ok: z.boolean(),
    status: z.number().int().optional(),
    resolved_url: z.string(),
    error_class: z.enum(["http_error", "timeout", "network"]).optional(),
    /** Human-readable warning, present when `ok` is false. */
    hint: z.string().optional(),
  })
  .meta({ id: "EndpointCheck" });

export type EndpointCheck = z.infer<typeof EndpointCheckSchema>;

function hintForStatus(status: number): string {
  if (status === 404) {
    return "The endpoint returned 404 for a test request: check the base path for this provider (e.g. NVIDIA needs /v1, OpenRouter needs /api/v1). Some providers gate requests behind auth, so this may be a false alarm.";
  }
  if (status === 401 || status === 403) {
    return `The endpoint rejected the credential for a test request (HTTP ${status}). Check the API key.`;
  }
  return `The endpoint returned HTTP ${status} for a test request.`;
}

/**
 * Probe a connection's custom endpoint with a minimal chat-completions
 * request (`max_tokens: 1`). Returns `null` when there is nothing to probe:
 * no custom base URL, no model id to send, or auth that cannot be resolved
 * (a missing credential surfaces through its own error path).
 */
export async function testInferenceConnection(
  connection: {
    provider: string;
    auth: Auth;
    baseUrl?: string | null;
    models?: ConnectionModel[] | null;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<EndpointCheck | null> {
  const model = connection.models?.[0]?.id;
  if (!connection.baseUrl || !model) {
    return null;
  }

  const resolved = await resolveAuth(connection.auth, connection.provider, {
    baseUrl: connection.baseUrl,
  });
  if (!resolved.ok || resolved.resolved.kind === "runtime_proxy") {
    return null;
  }
  const authHeaders =
    resolved.resolved.kind === "header" ? resolved.resolved.headers : {};

  const url = `${connection.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    void res.body?.cancel();
    if (res.ok) {
      return { ok: true, status: res.status, resolved_url: url };
    }
    return {
      ok: false,
      status: res.status,
      resolved_url: url,
      error_class: "http_error",
      hint: hintForStatus(res.status),
    };
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    log.info(
      { url, error: err instanceof Error ? err.message : String(err) },
      "Endpoint probe failed to reach the endpoint",
    );
    return {
      ok: false,
      resolved_url: url,
      error_class: isTimeout ? "timeout" : "network",
      hint: isTimeout
        ? `The endpoint did not respond within ${PROBE_TIMEOUT_MS / 1000}s for a test request.`
        : `Could not reach the endpoint for a test request: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
