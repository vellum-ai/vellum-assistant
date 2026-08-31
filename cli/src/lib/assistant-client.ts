/**
 * Gateway client for authenticated requests to a hatched assistant's runtime.
 *
 * Encapsulates lockfile reading, credential resolution, and authenticated
 * fetch so callers can simply do:
 *
 * ```ts
 * const client = new AssistantClient();                          // active / latest
 * const client = new AssistantClient({ assistantId: "my-bot" }); // by name
 * await client.get("/healthz");
 * await client.post("/messages/", { content: "hi" });
 * ```
 *
 * The auth scheme follows the assistant's topology, so callers never pick it.
 * Platform-managed entries in particular have no local guardian token: they
 * authenticate against the wildcard runtime proxy at
 * `{platformUrl}/v1/assistants/<id>/<rest>` with the stored platform credential.
 */

import { resolveAssistant } from "./assistant-config.js";
import { GATEWAY_PORT } from "./constants.js";
import {
  loadGuardianToken,
  refreshGuardianToken,
  guardianTokenDueForRenewal,
} from "./guardian-token.js";
import { loopbackSafeFetch } from "./loopback-fetch.js";
import {
  authHeaders,
  invalidateOrgIdCache,
  readPlatformToken,
} from "./platform-client.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const FALLBACK_RUNTIME_URL = `http://127.0.0.1:${GATEWAY_PORT}`;

/**
 * - `guardian`: `Authorization: Bearer <guardian JWT>`, refreshable on a 401.
 * - `session`: caller-supplied `X-Session-Token` + explicit org id.
 * - `platform`: `cloud: "vellum"` entry; headers resolved lazily from the
 *   stored platform token (org id needs a network lookup).
 */
type AuthMode = "guardian" | "session" | "platform";

const stripTrailingSlashes = (url: string): string => url.replace(/\/+$/, "");

export interface AssistantClientOpts {
  assistantId?: string;
  runtimeUrl?: string;
  /**
   * When provided alongside `orgId`, the client authenticates with a
   * session token instead of a guardian token.  The session token is
   * sent as `X-Session-Token: <sessionToken>` and the org id is
   * sent via the `Vellum-Organization-Id` header.
   *
   * Platform-managed assistants do NOT need this: they are detected from the
   * lockfile entry and authenticated from the stored platform token.
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
  /**
   * The credential for the current mode. Mutable: a 401 on the guardian path
   * refreshes it in place (see request), and the platform path fills it in on
   * first use (see resolveAuthHeaders).
   */
  private token: string | undefined;
  private readonly authMode: AuthMode;
  private readonly orgId: string | undefined;
  /** Cached in-flight/resolved platform auth headers; cleared to force a re-resolve. */
  private platformHeaders: Promise<Record<string, string>> | undefined;

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

    this._assistantId = entry.assistantId;
    const platformManaged = !opts?.sessionToken && entry.cloud === "vellum";
    const platformHost = stripTrailingSlashes(entry.runtimeUrl);

    // SECURITY: a platform credential is account-scoped, far broader than the
    // per-assistant guardian JWT, so its origin is pinned to the host recorded in
    // the lockfile. Honoring a URL override here would hand the caller's session
    // token or `vak_` key to whatever host they named.
    if (
      platformManaged &&
      opts?.runtimeUrl &&
      stripTrailingSlashes(opts.runtimeUrl) !== platformHost
    ) {
      throw new Error(
        `Refusing to send platform credentials to '${opts.runtimeUrl}': ` +
          `assistant '${entry.assistantId}' is hosted at ${platformHost}.`,
      );
    }

    this.runtimeUrl = platformManaged
      ? platformHost
      : stripTrailingSlashes(
          opts?.runtimeUrl ||
            entry.localUrl ||
            entry.runtimeUrl ||
            FALLBACK_RUNTIME_URL,
        );

    if (opts?.sessionToken) {
      // Caller supplied the credential: X-Session-Token + Vellum-Organization-Id.
      this.token = opts.sessionToken;
      this.authMode = "session";
      this.orgId = opts.orgId;
    } else if (platformManaged) {
      // Platform-managed: no guardian token exists locally, so authenticate with
      // the stored platform credential. Resolved on first use because the org id
      // behind it needs a network lookup.
      this.token = undefined;
      this.authMode = "platform";
      this.orgId = undefined;
    } else {
      this.token =
        loadGuardianToken(this._assistantId)?.accessToken ?? entry.bearerToken;
      this.authMode = "guardian";
      this.orgId = undefined;
    }
  }

  /**
   * Platform token for a `cloud: "vellum"` entry. Throws the actionable login
   * error rather than letting an anonymous request fall through to a bare 403.
   */
  private requirePlatformToken(): string {
    const token = readPlatformToken();
    if (!token) {
      throw new Error(
        "Not logged in. Run `vellum login` first to authenticate with the platform.",
      );
    }
    return token;
  }

  /**
   * Auth headers for the current mode. `authHeaders` picks the right scheme for
   * the platform credential (`Authorization: Bearer` for `vak_` API keys,
   * `X-Session-Token` + `Vellum-Organization-Id` for session tokens) and caches
   * the org-id lookup, so the result is memoized per client and a failure is
   * never cached.
   */
  private async resolveAuthHeaders(): Promise<Record<string, string>> {
    if (this.authMode !== "platform") {
      const headers: Record<string, string> = {};
      if (this.token) {
        if (this.authMode === "session") {
          headers["X-Session-Token"] = this.token;
        } else {
          headers["Authorization"] = `Bearer ${this.token}`;
        }
      }
      if (this.orgId) {
        headers["Vellum-Organization-Id"] = this.orgId;
      }
      return headers;
    }

    if (!this.platformHeaders) {
      this.token = this.requirePlatformToken();
      this.platformHeaders = authHeaders(this.token, this.runtimeUrl)
        .then((resolved) => {
          // request() owns Content-Type (bodyless requests must not carry one).
          const headers = { ...resolved };
          delete headers["Content-Type"];
          return headers;
        })
        .catch((err: unknown) => {
          this.platformHeaders = undefined;
          throw err;
        });
    }
    return this.platformHeaders;
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
    const jsonBody = body !== undefined ? JSON.stringify(body) : undefined;

    // Headers are built per-attempt so a refreshed token is picked up on retry.
    // Caller-supplied headers win over the resolved auth headers.
    const buildHeaders = async (): Promise<Record<string, string>> => {
      const headers: Record<string, string> = { ...opts?.headers };
      for (const [name, value] of Object.entries(
        await this.resolveAuthHeaders(),
      )) {
        headers[name] ??= value;
      }
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
      }
      return headers;
    };

    const doFetch = async (): Promise<Response> => {
      const headers = await buildHeaders();
      if (opts?.signal) {
        return loopbackSafeFetch(url, {
          method,
          headers,
          body: jsonBody,
          signal: opts.signal,
        });
      }
      const timeout = opts?.timeout ?? DEFAULT_TIMEOUT_MS;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      return loopbackSafeFetch(url, {
        method,
        headers,
        body: jsonBody,
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId));
    };

    const response = await doFetch();

    // A stale cached Vellum-Organization-Id is the usual cause of a 401 on the
    // platform path (e.g. the user switched orgs elsewhere). Drop it and retry
    // once. Mirrors localRuntimeIdentity in local-runtime-client.ts.
    if (response.status === 401 && this.authMode === "platform" && this.token) {
      invalidateOrgIdCache(this.token, this.runtimeUrl);
      this.platformHeaders = undefined;
      return doFetch();
    }

    // Reactive auto-refresh on a 401 for the guardian path only. Ephemeral
    // (`--token`) and access-only sessions have no stored refresh credential and
    // just see the original 401; session and platform credentials are managed by
    // the Vellum platform and are never refreshed here.
    if (response.status === 401 && this.authMode === "guardian") {
      const stored = loadGuardianToken(this._assistantId);

      // Another process may have already rotated and persisted a fresh access
      // token (e.g. a concurrent `vellum events`). Adopt it and retry — this
      // sends no refresh credential, just picks up the newer local token.
      if (stored?.accessToken && stored.accessToken !== this.token) {
        this.token = stored.accessToken;
        return doFetch();
      }

      // Otherwise only disclose the long-lived refresh token when our access
      // token is actually due for renewal. A 401 on a still-valid token (e.g. a
      // forged 401 from an impostor endpoint trying to coax out the refresh
      // credential) is surfaced as-is, not refreshed.
      if (stored?.refreshToken && guardianTokenDueForRenewal(stored)) {
        const refreshed = await refreshGuardianToken(
          this.runtimeUrl,
          this._assistantId,
        );
        if (refreshed?.accessToken) {
          this.token = refreshed.accessToken;
          return doFetch();
        }
      }
    }

    return response;
  }
}
