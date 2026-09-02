/**
 * Receive-side guard for credential-backed connections.
 *
 * A provider instance bakes in the credential it resolved at construction, so
 * a credential removed afterwards is still dispatched with. Several upstreams
 * answer an unusable key with `200` and an empty `content` array rather than a
 * `401`, which reaches the user as a blank assistant turn with nothing to act
 * on. This wrapper converts that pair (no usable content, and the
 * connection's credential definitively absent from the vault) into the
 * same `ConnectionResolutionError` the pre-dispatch preflight raises, so the
 * conversation layer renders its actionable "missing credential" error.
 *
 * A response with content passes through untouched, and an unreachable
 * credential store (`indeterminate`) is never reported as a missing
 * credential.
 */

import type { ProviderRouteAttribution } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { hasToolUse, hasVisibleText } from "../content-blocks.js";
import { checkCredentialPresence } from "../provider-availability.js";
import { ConnectionResolutionError } from "../routing-identity.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../types.js";

const log = getLogger("providers/missing-credential-guard");

export class MissingCredentialGuardProvider implements Provider {
  readonly name: string;
  readonly tokenEstimationProvider?: string;
  readonly defaultModel?: string;
  readonly supportsNativeWebSearch?: boolean;
  readonly countInputTokens?: NonNullable<Provider["countInputTokens"]>;

  constructor(
    private readonly inner: Provider,
    private readonly connection: {
      name: string;
      credentialAccount: string;
    },
  ) {
    this.name = inner.name;
    this.tokenEstimationProvider = inner.tokenEstimationProvider;
    this.defaultModel = inner.defaultModel;
    this.supportsNativeWebSearch = inner.supportsNativeWebSearch;
    if (inner.countInputTokens) {
      this.countInputTokens = inner.countInputTokens.bind(inner);
    }
  }

  /**
   * Route attribution is assigned onto the outermost provider after
   * construction (`attachProviderRoute`), and read back off it by usage
   * accounting, so it reads and writes through to the wrapped instance.
   */
  get routeAttribution(): ProviderRouteAttribution | undefined {
    return this.inner.routeAttribution;
  }

  set routeAttribution(attribution: ProviderRouteAttribution | undefined) {
    this.inner.routeAttribution = attribution;
  }

  supportsNativeWebSearchFor(options?: SendMessageOptions): boolean {
    return this.inner.supportsNativeWebSearchFor
      ? this.inner.supportsNativeWebSearchFor(options)
      : this.inner.supportsNativeWebSearch === true;
  }

  async sendMessage(
    messages: Message[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const response = await this.inner.sendMessage(messages, options);
    if (hasVisibleText(response.content) || hasToolUse(response.content)) {
      return response;
    }

    // An empty turn has causes other than a deleted key (a genuinely empty
    // completion, a refusal, a stop-sequence hit), so the credential read is
    // what decides, and only its definitive `absent` answer does.
    const presence = await checkCredentialPresence(
      this.connection.credentialAccount,
    );
    if (presence !== "absent") {
      return response;
    }

    log.warn(
      {
        connectionName: this.connection.name,
        credential: this.connection.credentialAccount,
        model: response.model,
        stopReason: response.stopReason,
      },
      "Upstream returned no usable content for a connection whose credential is absent, so a configuration error is surfaced rather than an empty turn",
    );

    throw new ConnectionResolutionError(
      this.connection.name,
      "missing_credential",
      `provider_connection "${this.connection.name}" answered with an empty response and has no credential stored: its API key was removed`,
      { model: response.model },
    );
  }
}
