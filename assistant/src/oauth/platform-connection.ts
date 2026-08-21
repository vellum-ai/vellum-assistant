import type { VellumPlatformClient } from "../platform/client.js";
import { BackendError } from "../util/errors.js";
import type { OAuthPlatformProxyCallerPlan } from "./caller-plan.js";
import type {
  OAuthConnection,
  OAuthConnectionRequest,
  OAuthConnectionResponse,
} from "./connection.js";
import {
  buildPlatformProxyEnvelope,
  buildPlatformProxyPath,
  executePlatformProxyRequest,
} from "./platform-proxy-request.js";

export {
  CredentialRequiredError,
  InsufficientBalanceError,
  ProviderUnreachableError,
} from "./platform-proxy-errors.js";

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
    const plan = await this.prepareCallerExecution(req);
    return executePlatformProxyRequest(
      this.client,
      plan.proxyPath,
      plan.envelope,
      req.signal,
    );
  }

  async prepareCallerExecution(
    req: OAuthConnectionRequest,
  ): Promise<OAuthPlatformProxyCallerPlan> {
    return {
      mode: "platform_proxy",
      proxyPath: buildPlatformProxyPath(
        this.client.platformAssistantId,
        this.connectionId,
      ),
      envelope: buildPlatformProxyEnvelope(req, this.baseUrl),
      account: this.accountInfo,
    };
  }

  async withToken<T>(_fn: (token: string) => Promise<T>): Promise<T> {
    throw new BackendError(
      "Raw token access is not supported for platform-managed connections. Use connection.request() instead.",
    );
  }
}
