import type { VellumPlatformClient } from "../platform/client.js";
import { BackendError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import { getHttpRetryDelay, isRetryableStatus, sleep } from "../util/retry.js";
import type {
  OAuthConnection,
  OAuthConnectionRequest,
  OAuthConnectionResponse,
} from "./connection.js";
import { isBinaryOAuthBody } from "./connection.js";

const log = getLogger("platform-oauth-connection");
const MAX_RETRIES = 3;

/** Status range the `Response` constructor accepts for a final response. */
const MIN_RESPONSE_STATUS = 200;
const MAX_RESPONSE_STATUS = 599;

export class CredentialRequiredError extends BackendError {
  constructor(
    message = "OAuth credential for this provider has expired or been revoked. The service needs to be reconnected.",
  ) {
    super(message);
    this.name = "CredentialRequiredError";
  }
}

export class ProviderUnreachableError extends BackendError {
  constructor(
    message = "The external service provider is temporarily unreachable. This may be a transient issue — retry after a brief pause.",
  ) {
    super(message);
    this.name = "ProviderUnreachableError";
  }
}

export class InsufficientBalanceError extends BackendError {
  constructor(
    message = "Your Vellum account balance is too low to use this managed OAuth connection. " +
      "You can add funds or switch to using your own OAuth app.",
  ) {
    super(message);
    this.name = "InsufficientBalanceError";
  }
}

/**
 * Request options the platform proxy cannot honor. It parses the response
 * body, rebuilds the query string from the parsed record, and follows provider
 * redirects server-side, so a managed connection answers with re-serialized
 * JSON, a regrouped query, and the redirect target's response. A caller that
 * needs the provider's exact bytes, its exact query string, or a verbatim 3xx
 * needs a BYO connection.
 */
const UNHONORED_MANAGED_OPTIONS = [
  "rawResponseBody",
  "manualRedirect",
  "rawQuery",
] as const;

/** Which of {@link UNHONORED_MANAGED_OPTIONS} this request asks for. */
export function unhonoredManagedOptions(req: OAuthConnectionRequest): string[] {
  return UNHONORED_MANAGED_OPTIONS.filter((option) => Boolean(req[option]));
}

const MANAGED_PROXY_REQUEST_HEADERS = new Set([
  "content-type",
  "accept",
  "user-agent",
  "x-request-id",
]);

/** Node fetch defaults can be dropped; other unsupported headers need caller handling. */
export function prepareManagedProxyHeaders(headers: Record<string, string>): {
  headers: Record<string, string>;
  unsupportedHeaders: string[];
} {
  const forwarded: Record<string, string> = {};
  const unsupportedHeaders: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (MANAGED_PROXY_REQUEST_HEADERS.has(lower)) {
      forwarded[lower] = value;
    } else if (
      !(lower === "accept-language" && value.trim() === "*") &&
      !(lower === "sec-fetch-mode" && value.trim() === "cors")
    ) {
      unsupportedHeaders.push(lower);
    }
  }
  return { headers: forwarded, unsupportedHeaders: unsupportedHeaders.sort() };
}

export interface PlatformOAuthConnectionOptions {
  id: string;
  provider: string;
  externalId: string;
  accountInfo: string | null;
  client: VellumPlatformClient;
  /** Platform-side connection ID used in the proxy URL path. */
  connectionId: string;
  /** Provider API base URL (e.g. "https://gmail.googleapis.com/gmail/v1/users/me").
   *  Sent to the proxy so it can construct the full upstream URL. */
  baseUrl?: string;
}

export class PlatformOAuthConnection implements OAuthConnection {
  readonly id: string;
  readonly provider: string;
  readonly externalId: string;
  readonly accountInfo: string | null;

  private readonly client: VellumPlatformClient;
  private readonly connectionId: string;
  private readonly baseUrl: string | undefined;

  constructor(options: PlatformOAuthConnectionOptions) {
    if (!options.connectionId) {
      throw new BackendError(
        `Platform-managed connection for "${options.provider}" cannot be created: missing connection ID. ` +
          `Log in to the Vellum platform or switch to using your own OAuth app.`,
      );
    }

    this.id = options.id;
    this.provider = options.provider;
    this.externalId = options.externalId;
    this.accountInfo = options.accountInfo;
    this.client = options.client;
    this.connectionId = options.connectionId;
    this.baseUrl = options.baseUrl;
  }

  async request(req: OAuthConnectionRequest): Promise<OAuthConnectionResponse> {
    const proxyPath = `/v1/assistants/${this.client.platformAssistantId}/external-provider-proxy/${this.connectionId}/`;

    // The envelope carries the caller's headers and body side by side. A
    // string body is placed in the envelope as a string, so the proxy forwards
    // those bytes verbatim under the caller's Content-Type. A Buffer is
    // base64-encoded so binary uploads survive JSON. An object body travels
    // as JSON and the proxy serializes it.
    const request: Record<string, unknown> = {
      method: req.method,
      path: req.path,
      query: req.query ?? {},
      headers: req.headers ?? {},
      body: req.body ?? null,
      ...((req.baseUrl ?? this.baseUrl)
        ? { base_url: req.baseUrl ?? this.baseUrl }
        : {}),
    };
    if (isBinaryOAuthBody(req.body)) {
      request.body = Buffer.from(req.body).toString("base64");
      request.body_encoding = "base64";
    }
    const body: Record<string, unknown> = { request };

    const unhonored = unhonoredManagedOptions(req);
    if (unhonored.length > 0) {
      log.debug(
        { provider: this.provider, options: unhonored },
        "Platform proxy handles the response server-side; these request options do not apply",
      );
    }

    // A retry replays the whole request upstream, and a 502 arrives only after
    // the platform already called the provider, so a caller forwarding a write
    // it cannot repeat gets a single attempt.
    const retriesAllowed = req.singleAttempt === true ? 0 : MAX_RETRIES;

    for (let attempt = 0; attempt <= retriesAllowed; attempt++) {
      const response = await this.client.fetch(proxyPath, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: req.signal,
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
        attempt < retriesAllowed
      ) {
        log.warn(
          { status: response.status, attempt, provider: "platform-proxy" },
          `Retryable status ${response.status} from platform proxy (attempt ${attempt + 1}/${retriesAllowed + 1})`,
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
        body_encoding?: string | null;
      };

      return decodePlatformProxyEnvelope(json);
    }

    throw new BackendError("Platform proxy request failed after retries");
  }

  async withToken<T>(_fn: (token: string) => Promise<T>): Promise<T> {
    throw new BackendError(
      "Raw token access is not supported for platform-managed connections. Use connection.request() instead.",
    );
  }
}

function decodePlatformProxyEnvelope(json: {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  body_encoding?: string | null;
}): OAuthConnectionResponse {
  // A status outside the range `Response` accepts cannot be emitted, and
  // clamping it would attribute a status to the provider that it never sent,
  // so an unusable envelope fails as a platform fault instead.
  const { status } = json;
  if (
    !Number.isInteger(status) ||
    status < MIN_RESPONSE_STATUS ||
    status > MAX_RESPONSE_STATUS
  ) {
    throw new BackendError(
      `Platform proxy returned an unusable response status: ${JSON.stringify(status)}`,
    );
  }

  let body = json.body;
  if (json.body_encoding === "base64") {
    if (typeof body !== "string") {
      throw new BackendError(
        "Platform proxy returned body_encoding=base64 without a string body",
      );
    }
    body = Buffer.from(body, "base64");
  }
  return {
    status,
    headers: json.headers ?? {},
    body,
  };
}
