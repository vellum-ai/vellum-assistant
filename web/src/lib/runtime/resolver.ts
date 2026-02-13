/**
 * Resolves the runtime base URL for an assistant.
 *
 * In local mode the runtime is the daemon's HTTP server running on the
 * same machine.  In cloud mode it's a hosted runtime endpoint.
 *
 * This module is intentionally kept simple — it reads environment config
 * and returns a URL string.  The RuntimeClient in `client.ts` handles
 * the actual HTTP calls.
 */

import {
  getAssistantConnectionMode,
  type AssistantConnectionMode,
} from "@/lib/assistant-connection";

const DEFAULT_LOCAL_RUNTIME_PORT = 7821;

export interface ResolvedRuntime {
  baseUrl: string;
  mode: AssistantConnectionMode;
}

/**
 * Resolve the runtime base URL for a given assistant.
 *
 * Environment variables:
 *   - `LOCAL_RUNTIME_URL`  — override the default local runtime URL
 *   - `CLOUD_RUNTIME_URL`  — base URL for the hosted cloud runtime
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function resolveRuntime(_assistantId: string): ResolvedRuntime {
  const mode = getAssistantConnectionMode();

  if (mode === "local") {
    const override = process.env.LOCAL_RUNTIME_URL?.trim();
    const baseUrl = override || `http://127.0.0.1:${DEFAULT_LOCAL_RUNTIME_PORT}`;
    return { baseUrl: normalizeBaseUrl(baseUrl), mode };
  }

  const cloudBase = process.env.CLOUD_RUNTIME_URL?.trim();
  if (!cloudBase) {
    throw new Error(
      "CLOUD_RUNTIME_URL must be set when running in cloud mode",
    );
  }

  return { baseUrl: normalizeBaseUrl(cloudBase), mode };
}

/**
 * Strip trailing slashes so callers can append paths directly.
 */
function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}
