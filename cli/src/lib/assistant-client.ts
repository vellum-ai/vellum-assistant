/**
 * Gateway client for authenticated requests to a hatched assistant's runtime.
 *
 * Encapsulates lockfile reading, guardian-token resolution, and
 * authenticated fetch so callers can simply do:
 *
 * ```ts
 * const client = new AssistantClient();               // active / latest
 * const client = new AssistantClient("my-assistant");  // by name
 * await client.get("/healthz");
 * await client.post("/messages/", { content: "hi" });
 * ```
 */

import {
  findAssistantByName,
  getActiveAssistant,
  loadLatestAssistant,
} from "./assistant-config.js";
import { GATEWAY_PORT } from "./constants.js";
import { loadGuardianToken } from "./guardian-token.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const FALLBACK_RUNTIME_URL = `http://127.0.0.1:${GATEWAY_PORT}`;

export interface RequestOpts {
  timeout?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export class AssistantClient {
  readonly runtimeUrl: string;
  readonly assistantId: string;

  private readonly token: string | undefined;

  /**
   * Resolves an assistant entry from the lockfile and loads auth credentials.
   *
   * @param nameOrId - Explicit assistant name. When omitted, the active
   *   assistant is used, falling back to the most recently hatched one.
   * @throws If no matching assistant is found.
   */
  constructor(nameOrId?: string) {
    let entry = nameOrId ? findAssistantByName(nameOrId) : null;

    if (nameOrId && !entry) {
      throw new Error(`No assistant found with name '${nameOrId}'.`);
    }

    if (!entry) {
      const active = getActiveAssistant();
      if (active) {
        entry = findAssistantByName(active);
      }
    }

    if (!entry) {
      entry = loadLatestAssistant();
    }

    if (!entry) {
      throw new Error(
        "No assistant found. Hatch one first with 'vellum hatch'.",
      );
    }

    this.runtimeUrl = (entry.runtimeUrl ?? FALLBACK_RUNTIME_URL).replace(
      /\/+$/,
      "",
    );
    this.assistantId = entry.assistantId;
    this.token =
      loadGuardianToken(this.assistantId)?.accessToken ?? entry.bearerToken;
  }

  /** GET request to the gateway. Auth headers are added automatically. */
  async get(urlPath: string, opts?: RequestOpts): Promise<Response> {
    return this.request("GET", urlPath, undefined, opts);
  }

  /** POST request to the gateway with a JSON body. Auth headers are added automatically. */
  async post(
    urlPath: string,
    body: unknown,
    opts?: RequestOpts,
  ): Promise<Response> {
    return this.request("POST", urlPath, body, opts);
  }

  /** PATCH request to the gateway with a JSON body. Auth headers are added automatically. */
  async patch(
    urlPath: string,
    body: unknown,
    opts?: RequestOpts,
  ): Promise<Response> {
    return this.request("PATCH", urlPath, body, opts);
  }

  private async request(
    method: string,
    urlPath: string,
    body: unknown | undefined,
    opts?: RequestOpts,
  ): Promise<Response> {
    const url = `${this.runtimeUrl}/v1/assistants/${this.assistantId}${urlPath}`;

    const headers: Record<string, string> = { ...opts?.headers };
    if (this.token) {
      headers["Authorization"] ??= `Bearer ${this.token}`;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const jsonBody = body !== undefined ? JSON.stringify(body) : undefined;

    if (opts?.signal) {
      return fetch(url, {
        method,
        headers,
        body: jsonBody,
        signal: opts.signal,
      });
    }

    const timeout = opts?.timeout ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      return await fetch(url, {
        method,
        headers,
        body: jsonBody,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
