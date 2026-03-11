import type {
  OAuthConnection,
  OAuthConnectionRequest,
  OAuthConnectionResponse,
} from "./connection.js";

export class CredentialRequiredError extends Error {
  constructor(message = "Connection not set up on platform") {
    super(message);
    this.name = "CredentialRequiredError";
  }
}

export class ProviderUnreachableError extends Error {
  constructor(message = "Provider is unreachable") {
    super(message);
    this.name = "ProviderUnreachableError";
  }
}

export interface PlatformOAuthConnectionOptions {
  id: string;
  providerKey: string;
  externalId: string;
  accountInfo: string | null;
  grantedScopes: string[];
  assistantId: string;
  platformBaseUrl: string;
  apiKey: string;
}

export class PlatformOAuthConnection implements OAuthConnection {
  readonly id: string;
  readonly providerKey: string;
  readonly externalId: string;
  readonly accountInfo: string | null;
  readonly grantedScopes: string[];

  private readonly assistantId: string;
  private readonly platformBaseUrl: string;
  private readonly apiKey: string;

  constructor(options: PlatformOAuthConnectionOptions) {
    this.id = options.id;
    this.providerKey = options.providerKey;
    this.externalId = options.externalId;
    this.accountInfo = options.accountInfo;
    this.grantedScopes = options.grantedScopes;
    this.assistantId = options.assistantId;
    this.platformBaseUrl = options.platformBaseUrl;
    this.apiKey = options.apiKey;
  }

  async request(req: OAuthConnectionRequest): Promise<OAuthConnectionResponse> {
    const providerSlug = this.providerKey.replace(/^integration:/, "");
    const proxyUrl = `${this.platformBaseUrl}/v1/assistants/${this.assistantId}/external-provider-proxy/${providerSlug}/`;

    const body: Record<string, unknown> = {
      request: {
        method: req.method,
        path: req.path,
        query: req.query ?? {},
        headers: req.headers ?? {},
        body: req.body ?? null,
        ...(req.baseUrl ? { baseUrl: req.baseUrl } : {}),
      },
    };

    const response = await fetch(proxyUrl, {
      method: "POST",
      headers: {
        Authorization: `Api-Key ${this.apiKey}`,
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
      throw new Error(
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
    throw new Error(
      "Raw token access is not supported for platform-managed connections. Use connection.request() instead.",
    );
  }
}
