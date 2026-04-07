import type { VellumPlatformClient } from "../platform/client.js";
import { BackendError } from "../util/errors.js";
import type {
  OAuthConnection,
  OAuthConnectionRequest,
  OAuthConnectionResponse,
} from "./connection.js";

export class CredentialRequiredError extends BackendError {
  constructor(message = "Connection not set up on platform") {
    super(message);
    this.name = "CredentialRequiredError";
  }
}

export class ProviderUnreachableError extends BackendError {
  constructor(message = "Provider is unreachable") {
    super(message);
    this.name = "ProviderUnreachableError";
  }
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

    const body: Record<string, unknown> = {
      request: {
        method: req.method,
        path: req.path,
        query: req.query ?? {},
        headers: req.headers ?? {},
        body: req.body ?? null,
        ...((req.baseUrl ?? this.baseUrl)
          ? { base_url: req.baseUrl ?? this.baseUrl }
          : {}),
      },
    };

    const response = await this.client.fetch(proxyPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (response.status === 424) {
      throw new CredentialRequiredError();
    }

    if (response.status === 502) {
      throw new ProviderUnreachableError();
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
    };

    return {
      status: json.status,
      headers: json.headers,
      body: json.body,
    };
  }

  async withToken<T>(_fn: (token: string) => Promise<T>): Promise<T> {
    throw new BackendError(
      "Raw token access is not supported for platform-managed connections. Use connection.request() instead.",
    );
  }
}
