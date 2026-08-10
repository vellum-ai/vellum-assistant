/**
 * OAuthClientProvider implementation for MCP servers.
 *
 * Credentials persist through secure-keys (the credential store). The
 * browser callback arrives on the assistant's shared OAuth callback route,
 * which the gateway already serves and forwards to
 * `POST /v1/internal/oauth/callback`; the runtime matches the arriving
 * OAuth `state` against `security/oauth-callback-registry.ts` and resolves
 * the waiting flow.
 *
 * The redirect URI comes from `resolveOauthCallbackUrl`, so it is the same
 * stable URL for every server and every attempt. That stability is what
 * makes dynamic client registration and Client ID Metadata Documents
 * usable: both pin `redirect_uris` at registration time, and the
 * authorization server matches the value exactly on each authorization
 * request.
 */

import { randomBytes } from "node:crypto";

import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import { getPlatformAssistantId } from "../config/env.js";
import { getAssistantName } from "../daemon/identity-helpers.js";
import {
  deleteSecureKeyAsync,
  getSecureKeyAsync,
  setSecureKeyAsync,
} from "../security/secure-keys.js";
import { openInHostBrowser } from "../util/browser.js";
import { getLogger } from "../util/logger.js";
import { APP_VERSION } from "../version.js";

const log = getLogger("mcp-oauth");

// Credential store key helpers
function tokensKey(serverId: string): string {
  return `mcp:${serverId}:tokens`;
}
function clientInfoKey(serverId: string): string {
  return `mcp:${serverId}:client_info`;
}
function discoveryKey(serverId: string): string {
  return `mcp:${serverId}:discovery`;
}
function clientBindingKey(serverId: string): string {
  return `mcp:${serverId}:client_binding`;
}

/**
 * Logo shown on an authorization server's consent screen.
 *
 * Anonymously fetchable, which is the requirement: the server loads it
 * without credentials. It identifies Vellum rather than the individual
 * assistant, so every assistant a person runs presents the same mark.
 */
const CLIENT_LOGO_URI = "https://www.vellum.ai/favicon.svg";

/**
 * What a stored client registration was made against.
 *
 * A client identifier belongs to the authorization server that issued it and
 * is registered for one set of redirect URIs, so reusing a registration after
 * either changes is invalid. Recording both is what lets a registration be
 * reused when they still hold, which is the difference between registering
 * once per assistant and registering once per attempt.
 */
interface ClientRegistrationBinding {
  issuer: string | null;
  redirectUri: string;
}

export interface McpOAuthCallbackResult {
  /** Resolves with the authorization code when the callback is received. */
  codePromise: Promise<string>;
}

export interface McpOAuthProviderOptions {
  /**
   * If provided, called with the authorization URL during
   * redirectToAuthorization() instead of opening a browser.
   * Used by the daemon-side orchestrator so it can return the
   * URL to the IPC caller (CLI / web client).
   */
  onAuthorizationUrl?: (url: string) => void;
}

export class McpOAuthProvider implements OAuthClientProvider {
  private readonly serverId: string;
  private readonly serverUrl: string;
  private readonly interactive: boolean;
  private _codeVerifier: string | undefined;
  private _state: string | undefined;
  private _redirectUrl: string | undefined;
  private _codePromise: Promise<string> | null = null;
  /** Deferred resolver/rejector for the callback code promise. */
  private _codeResolve: ((code: string) => void) | undefined;
  private _codeReject: ((err: Error) => void) | undefined;
  private readonly _onAuthorizationUrl: ((url: string) => void) | undefined;

  /**
   * @param interactive When true (e.g. `mcp auth` CLI), opens browser for OAuth.
   *                    When false (daemon), logs a message instead.
   * @param options Additional options for the provider.
   */
  constructor(
    serverId: string,
    serverUrl: string,
    interactive = false,
    options: McpOAuthProviderOptions = {},
  ) {
    this.serverId = serverId;
    this.serverUrl = serverUrl;
    this.interactive = interactive;
    this._onAuthorizationUrl = options.onAuthorizationUrl;
  }

  // --- redirectUrl ---

  get redirectUrl(): string | undefined {
    return this._redirectUrl;
  }

  // --- clientMetadata ---

  /**
   * Identity presented at dynamic registration, and on the consent screen
   * the user reads before approving.
   *
   * The client is this assistant, not the Vellum product and not the plugin
   * that declared the server: each assistant registers separately, with its
   * own redirect URI, so its own name is what makes the consent screen
   * meaningful when a person runs several. `software_id` carries the
   * assistant id so a server can correlate an assistant's registrations
   * across servers without treating every assistant as the same client.
   *
   * `logo_uri` is the Vellum mark rather than the assistant's own avatar.
   * An authorization server fetching a logo is anonymous, and the avatar is
   * served only behind authentication, so there is no per-assistant URL to
   * give it. A stable public identity per assistant is what would supply
   * one, and the same prerequisite would let this move to Client ID
   * Metadata Documents and drop registration altogether.
   */
  get clientMetadata(): OAuthClientMetadata {
    const assistantName = getAssistantName();
    const assistantId = getPlatformAssistantId().trim();
    return {
      client_name: assistantName ?? "Vellum Assistant",
      logo_uri: CLIENT_LOGO_URI,
      redirect_uris: this._redirectUrl ? [this._redirectUrl] : [],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...(assistantId.length > 0 && { software_id: assistantId }),
      software_version: APP_VERSION,
    };
  }

  // --- Tokens ---

  async tokens(): Promise<OAuthTokens | undefined> {
    const raw = await getSecureKeyAsync(tokensKey(this.serverId));
    if (!raw) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as OAuthTokens;
    } catch {
      log.warn(
        { serverId: this.serverId },
        "Failed to parse stored OAuth tokens",
      );
      return undefined;
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    // RFC 6749 §6 lets a token endpoint rotate the refresh_token, omit
    // it, or leave it unchanged. Many MCP servers issue a fresh
    // access_token without a new refresh_token on every refresh grant;
    // overwriting storage verbatim would then drop the refresh_token
    // we still need to send on the next silent refresh. Carry forward
    // the previous refresh_token when the incoming response omits one.
    let toPersist: OAuthTokens = tokens;
    if (!tokens.refresh_token) {
      const previous = await getSecureKeyAsync(tokensKey(this.serverId));
      if (previous) {
        try {
          const parsed = JSON.parse(previous) as OAuthTokens;
          if (parsed.refresh_token) {
            toPersist = { ...tokens, refresh_token: parsed.refresh_token };
          }
        } catch {
          // Existing payload is malformed; fall through and save as-is.
        }
      }
    }
    const ok = await setSecureKeyAsync(
      tokensKey(this.serverId),
      JSON.stringify(toPersist),
    );
    if (!ok) {
      log.warn(
        { serverId: this.serverId },
        "Failed to persist OAuth tokens to secure storage",
      );
      return;
    }
    log.info({ serverId: this.serverId }, "OAuth tokens saved");
  }

  // --- Refresh-Token Grant ---

  /**
   * Build the URL-encoded body for a refresh-token grant request.
   *
   * The MCP SDK calls this method when it needs to obtain a fresh
   * access token without an authorization code (typically after a 401
   * on an existing MCP request). We return a `refresh_token` grant if
   * the stored tokens include one; otherwise we return `undefined` so
   * the SDK falls back to the full authorization-code flow.
   *
   * Per RFC 6749 §6, omitting `scope` on refresh means the server
   * reuses the originally authorized scope — the default most MCP
   * servers (including Nirvana) expect.
   */
  async prepareTokenRequest(
    scope?: string,
  ): Promise<URLSearchParams | undefined> {
    const tokens = await this.tokens();
    if (!tokens?.refresh_token) {
      return undefined;
    }
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    if (scope) {
      params.set("scope", scope);
    }
    return params;
  }

  // --- Client Information ---

  /**
   * The stored registration, or `undefined` to make the SDK register a new
   * one.
   *
   * Returning the stored value is the normal case: dynamic registration
   * writes a record on the authorization server, so re-registering per
   * attempt accumulates records nobody cleans up. It is withheld only when
   * the registration provably no longer applies, because the redirect URI
   * it was made for changed or because a different authorization server now
   * fronts the resource.
   */
  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const raw = await getSecureKeyAsync(clientInfoKey(this.serverId));
    if (!raw) {
      return undefined;
    }

    let info: OAuthClientInformationMixed;
    try {
      info = JSON.parse(raw) as OAuthClientInformationMixed;
    } catch {
      log.warn(
        { serverId: this.serverId },
        "Failed to parse stored client information",
      );
      return undefined;
    }

    const stale = await this.describeStaleBinding();
    if (stale) {
      log.info(
        { serverId: this.serverId, reason: stale },
        "Stored client registration no longer applies; registering again",
      );
      return undefined;
    }
    return info;
  }

  async saveClientInformation(
    info: OAuthClientInformationMixed,
  ): Promise<void> {
    const ok = await setSecureKeyAsync(
      clientInfoKey(this.serverId),
      JSON.stringify(info),
    );
    if (!ok) {
      log.warn(
        { serverId: this.serverId },
        "Failed to persist OAuth client information to secure storage",
      );
      return;
    }

    // Record what the registration was made against, so a later run can tell
    // whether reusing it is still valid.
    if (this._redirectUrl) {
      const binding: ClientRegistrationBinding = {
        issuer: await this.currentIssuer(),
        redirectUri: this._redirectUrl,
      };
      const boundOk = await setSecureKeyAsync(
        clientBindingKey(this.serverId),
        JSON.stringify(binding),
      );
      if (!boundOk) {
        log.warn(
          { serverId: this.serverId },
          "Failed to persist OAuth client binding; the registration will be remade on the next flow",
        );
      }
    }

    log.info({ serverId: this.serverId }, "OAuth client information saved");
  }

  /** Issuer of the authorization server currently in play, when known. */
  private async currentIssuer(): Promise<string | null> {
    const state = await this.discoveryState();
    return (
      state?.authorizationServerMetadata?.issuer ??
      state?.authorizationServerUrl ??
      null
    );
  }

  /**
   * Why the stored registration cannot be reused, or null when it can.
   *
   * The redirect URI is only checked while a flow is being prepared:
   * outside one there is no redirect URI to compare against, and a silent
   * reconnect must not be turned into a registration.
   *
   * The issuer is only checked when discovery has run. An unverifiable
   * issuer keeps the registration rather than discarding it, since the
   * redirect check already covers the case this plugin actually changes.
   */
  private async describeStaleBinding(): Promise<string | null> {
    const raw = await getSecureKeyAsync(clientBindingKey(this.serverId));
    if (!raw) {
      // Registered before the binding was recorded. Keep it: discarding
      // every pre-existing registration would remake all of them at once.
      return null;
    }

    let binding: ClientRegistrationBinding;
    try {
      binding = JSON.parse(raw) as ClientRegistrationBinding;
    } catch {
      return "stored binding is unreadable";
    }

    if (this._redirectUrl && binding.redirectUri !== this._redirectUrl) {
      return "redirect URI changed";
    }

    const issuer = await this.currentIssuer();
    if (issuer && binding.issuer && binding.issuer !== issuer) {
      return "authorization server changed";
    }
    return null;
  }

  // --- Code Verifier (in-memory, ephemeral) ---

  async saveCodeVerifier(verifier: string): Promise<void> {
    this._codeVerifier = verifier;
  }

  async codeVerifier(): Promise<string> {
    if (!this._codeVerifier) {
      throw new Error("No code verifier available — OAuth flow not started");
    }
    return this._codeVerifier;
  }

  // --- State (CSRF token for OAuth) ---

  /**
   * Return a `state` value for the authorization URL.
   *
   * The MCP SDK calls `provider.state?.()` and, when the return value is
   * truthy, appends it as the `state` query parameter.  For the **gateway**
   * transport the state is mandatory because it is the key used by the
   * `oauth-callback-registry` to route the redirect back to this flow.
   * For the **loopback** transport the state is optional (the loopback
   * server matches on the callback URL itself), but we generate one anyway
   * for defense-in-depth.
   */
  async state(): Promise<string> {
    if (!this._state) {
      this._state = randomBytes(16).toString("hex");
    }
    return this._state;
  }

  // --- Discovery State ---

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const raw = await getSecureKeyAsync(discoveryKey(this.serverId));
    if (!raw) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as OAuthDiscoveryState;
    } catch {
      return undefined;
    }
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    const ok = await setSecureKeyAsync(
      discoveryKey(this.serverId),
      JSON.stringify(state),
    );
    if (!ok) {
      log.warn(
        { serverId: this.serverId },
        "Failed to persist OAuth discovery state to secure storage",
      );
    }
  }

  // --- Redirect to Authorization ---

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const url = authorizationUrl.toString();

    // The callback is demultiplexed by OAuth `state`, and the SDK mints it
    // while building this URL, so this is the earliest point the pending
    // callback can be registered.
    if (this._codeResolve && this._codeReject) {
      const sdkState = authorizationUrl.searchParams.get("state");
      if (sdkState) {
        // Dynamic import to avoid circular deps
        const { registerPendingCallback } =
          await import("../security/oauth-callback-registry.js");
        registerPendingCallback(sdkState, this._codeResolve, this._codeReject);
        log.info(
          { serverId: this.serverId, state: sdkState },
          "MCP OAuth callback registered with SDK state",
        );
      } else {
        log.warn(
          { serverId: this.serverId },
          "Authorization URL missing state parameter, callback may not resolve",
        );
      }
    }

    if (this._onAuthorizationUrl) {
      this._onAuthorizationUrl(url);
      return;
    }

    if (!this.interactive) {
      // Daemon mode — don't open browser, just log guidance
      log.info(
        { serverId: this.serverId },
        "OAuth required but running in non-interactive mode",
      );
      return;
    }

    log.info(
      { serverId: this.serverId },
      "Opening browser for OAuth authorization",
    );
    console.log(
      `[MCP] Opening browser for OAuth authorization of "${this.serverId}"...`,
    );

    await openInHostBrowser(url);
    console.log(`[MCP] If the browser did not open, visit this URL:\n${url}`);
  }

  // --- Invalidate Credentials ---

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    log.info(
      { serverId: this.serverId, scope },
      "Invalidating OAuth credentials",
    );

    if (scope === "all" || scope === "tokens") {
      const result = await deleteSecureKeyAsync(tokensKey(this.serverId));
      if (result === "error") {
        log.warn(
          { serverId: this.serverId },
          "Failed to delete OAuth tokens from secure storage",
        );
      } else if (result === "not-found") {
        log.debug(
          { serverId: this.serverId },
          "OAuth tokens key not found in secure storage (already removed)",
        );
      }
    }
    if (scope === "all" || scope === "client") {
      const result = await deleteSecureKeyAsync(clientInfoKey(this.serverId));
      if (result === "error") {
        log.warn(
          { serverId: this.serverId },
          "Failed to delete OAuth client information from secure storage",
        );
      } else if (result === "not-found") {
        log.debug(
          { serverId: this.serverId },
          "OAuth client information key not found in secure storage (already removed)",
        );
      }
      // The binding describes the registration being dropped, so it goes
      // with it. Leaving it would let a later registration inherit the
      // previous one's issuer and redirect URI.
      await deleteSecureKeyAsync(clientBindingKey(this.serverId));
    }
    if (scope === "all" || scope === "verifier") {
      this._codeVerifier = undefined;
      this._state = undefined;
    }
    if (scope === "all" || scope === "discovery") {
      const result = await deleteSecureKeyAsync(discoveryKey(this.serverId));
      if (result === "error") {
        log.warn(
          { serverId: this.serverId },
          "Failed to delete OAuth discovery state from secure storage",
        );
      } else if (result === "not-found") {
        log.debug(
          { serverId: this.serverId },
          "OAuth discovery state key not found in secure storage (already removed)",
        );
      }
    }
  }

  // --- Callback ---

  /**
   * Prepare to receive the OAuth callback.
   *
   * Resolves the shared redirect URI the gateway serves and creates a
   * deferred code promise. There is no listener to start: the gateway
   * already accepts `webhooks/oauth/callback` and forwards it to
   * `POST /v1/internal/oauth/callback`, which resolves the waiting flow
   * by matching the arriving OAuth `state`.
   *
   * `registerPendingCallback` is deferred to `redirectToAuthorization`,
   * the first point at which the SDK-generated `state` is known.
   */
  async startCallbackServer(): Promise<McpOAuthCallbackResult> {
    const { resolveOauthCallbackUrl } =
      await import("../inbound/oauth-callback-url.js");

    this._redirectUrl = await resolveOauthCallbackUrl();

    const codePromise = new Promise<string>((resolve, reject) => {
      this._codeResolve = resolve;
      this._codeReject = reject;
    });
    this._codePromise = codePromise;

    // stopCallbackServer() can reject this deferred before any consumer is
    // attached. Without a handler that rejection is unhandled, which the daemon
    // treats as fatal; the no-op catch keeps it observed while a real consumer
    // awaits the same promise and still sees the rejection.
    void codePromise.catch(() => {});

    log.info(
      { serverId: this.serverId, redirectUrl: this._redirectUrl },
      "MCP OAuth callback prepared (awaiting state from auth URL)",
    );

    return { codePromise };
  }

  /** Returns the code promise created by {@link startCallbackServer}. */
  waitForCode(): Promise<string> {
    if (!this._codePromise) {
      throw new Error(
        "Callback not prepared, call startCallbackServer() first",
      );
    }
    return this._codePromise;
  }

  /**
   * Abandon a prepared callback. Rejects the deferred promise so callers
   * awaiting the code do not hang until the registry's own TTL fires.
   */
  stopCallbackServer(): void {
    if (this._codeReject) {
      this._codeReject(new Error("MCP OAuth callback cancelled"));
      this._codeResolve = undefined;
      this._codeReject = undefined;
    }
  }
}

// --- Static helpers ---

/**
 * Check whether OAuth tokens exist in the credential store for a server.
 */
export async function hasMcpOAuthTokens(serverId: string): Promise<boolean> {
  const raw = await getSecureKeyAsync(tokensKey(serverId));
  return raw != null && raw.length > 0;
}

/**
 * Delete all OAuth credentials for a given MCP server.
 * Used by `mcp remove` for cleanup.
 */
export async function deleteMcpOAuthCredentials(
  serverId: string,
): Promise<{ ok: boolean; failedKeys: string[] }> {
  const [tokensResult, clientResult, bindingResult, discoveryResult] =
    await Promise.all([
      deleteSecureKeyAsync(tokensKey(serverId)),
      deleteSecureKeyAsync(clientInfoKey(serverId)),
      deleteSecureKeyAsync(clientBindingKey(serverId)),
      deleteSecureKeyAsync(discoveryKey(serverId)),
    ]);
  const results = [
    { key: "tokens", result: tokensResult },
    { key: "client_info", result: clientResult },
    { key: "client_binding", result: bindingResult },
    { key: "discovery", result: discoveryResult },
  ];
  const failedKeys = results
    .filter((r) => r.result === "error")
    .map((r) => r.key);
  if (failedKeys.length > 0) {
    log.warn(
      { serverId, failedKeys },
      "Some OAuth credentials could not be deleted from secure storage",
    );
  }
  const ok = failedKeys.length === 0;
  log.info(
    { serverId },
    ok
      ? "OAuth credentials deleted"
      : "OAuth credential deletion completed with errors",
  );
  return { ok, failedKeys };
}
