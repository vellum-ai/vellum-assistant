/**
 * Gateway client for authenticated requests to a hatched assistant's runtime.
 *
 * Encapsulates lockfile reading, guardian-token resolution, and
 * authenticated fetch so callers can simply do:
 *
 * ```ts
 * const client = new AssistantClient();                          // active / latest
 * const client = new AssistantClient({ assistantId: "my-bot" }); // by name
 * await client.get("/healthz");
 * await client.post("/messages/", { content: "hi" });
 * ```
 */

import {
  resolveAssistant,
} from "./assistant-config.js";
import { GATEWAY_PORT } from "./constants.js";
import { loadGuardianToken } from "./guardian-token.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const FALLBACK_RUNTIME_URL = `http://127.0.0.1:${GATEWAY_PORT}`;

export interface AssistantClientOpts {
  assistantId?: string;
  /**
   * When provided alongside `orgId`, the client authenticates with a
   * session token instead of a guardian token.  The session token is
   * sent as `X-Session-Token: <sessionToken>` and the org id is
   * sent via the `Vellum-Organization-Id` header.
   */
  sessionToken?: string;
  /** Required when `sessionToken` is provided. */
  orgId?: string;
}

export interface RequestOpts {
  timeout?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

export class AssistantClient {
  readonly runtimeUrl: string;

  private readonly _assistantId: string;
  private readonly token: string | undefined;
  /** True when token is a platform session token (X-Session-Token), false for guardian JWT (Authorization: Bearer). */
  private readonly isSessionAuth: boolean;
  private readonly orgId: string | undefined;

  /**
   * Resolves an assistant entry from the lockfile and loads auth credentials.
   *
   * @param opts.assistantId - Explicit assistant name. When omitted, the
   *   active assistant is used, falling back to the most recently hatched one.
   * @throws If no matching assistant is found.
   */
  constructor(opts?: AssistantClientOpts) {
    const entry = resolveAssistant(opts?.assistantId);

    if (!entry) {
      throw new Error(
        opts?.assistantId
          ? `No assistant found with name '${opts.assistantId}'.`
          : "No assistant found. Hatch one first with 'vellum hatch'.",
      );
    }

    this.runtimeUrl = (
      entry.localUrl ||
      entry.runtimeUrl ||
      FALLBACK_RUNTIME_URL
    ).replace(/\/+$/, "");
    this._assistantId = entry.assistantId;

    if (opts?.sessionToken) {
      // Platform assistant: use X-Session-Token + Vellum-Organization-Id.
      this.token = opts.sessionToken;
      this.isSessionAuth = true;
      this.orgId = opts.orgId;
    } else {
      this.token =
        loadGuardianToken(this._assistantId)?.accessToken ?? entry.bearerToken;
      this.isSessionAuth = false;
      this.orgId = undefined;
    }
  }

  /** GET request to the gateway. Auth headers are added automatically. */
  async get(urlPath: string, opts?: RequestOpts): Promise<Response> {
    return this.request("GET", urlPath, undefined, opts);
  }

  /**
   * Subscribe to an SSE endpoint and yield parsed JSON objects from `data:` lines.
   * Automatically sets `Accept: text/event-stream` and skips heartbeat comments.
   */
  async *stream<T = unknown>(
    urlPath: string,
    opts?: RequestOpts,
  ): AsyncGenerator<T> {
    const response = await this.get(urlPath, {
      ...opts,
      headers: { Accept: "text/event-stream", ...opts?.headers },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `HTTP ${response.status}: ${body || response.statusText}`,
      );
    }

    if (!response.body) {
      throw new Error("No response body received.");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });

      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        if (!frame.trim() || frame.startsWith(":")) continue;

        let data: string | undefined;
        for (const line of frame.split("\n")) {
          if (line.startsWith("data: ")) {
            data = line.slice(6);
          }
        }

        if (!data) continue;

        try {
          yield JSON.parse(data) as T;
        } catch {
          // Skip malformed JSON
        }
      }
    }
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
    const qs = opts?.query
      ? `?${new URLSearchParams(opts.query).toString()}`
      : "";
    const url = `${this.runtimeUrl}/v1/assistants/${this._assistantId}${urlPath}${qs}`;

    const headers: Record<string, string> = { ...opts?.headers };
    if (this.token) {
      if (this.isSessionAuth) {
        headers["X-Session-Token"] ??= this.token;
      } else {
        headers["Authorization"] ??= `Bearer ${this.token}`;
      }
    }
    if (this.orgId) {
      headers["Vellum-Organization-Id"] ??= this.orgId;
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
