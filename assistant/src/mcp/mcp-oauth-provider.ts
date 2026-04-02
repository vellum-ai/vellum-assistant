/**
 * OAuthClientProvider implementation for MCP servers.
 *
 * Uses secure-keys (credential store) for persistent credential storage
 * and a loopback HTTP server for the browser callback.
 */

import { createServer, type Server } from "node:http";

import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import {
  deleteSecureKeyAsync,
  getSecureKeyAsync,
  setSecureKeyAsync,
} from "../security/secure-keys.js";
import { openInHostBrowser } from "../util/browser.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("mcp-oauth");

const CALLBACK_PATH = "/oauth/callback";
const CALLBACK_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

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

export interface McpOAuthCallbackResult {
  /** Resolves with the authorization code when the callback is received. */
  codePromise: Promise<string>;
}

export class McpOAuthProvider implements OAuthClientProvider {
  private readonly serverId: string;
  private readonly serverUrl: string;
  private readonly interactive: boolean;
  private _codeVerifier: string | undefined;
  private _redirectUrl: string | undefined;
  private _codePromise: Promise<string> | null = null;
  private callbackServer: Server | null = null;
  private callbackTimeout: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param interactive When true (e.g. `mcp auth` CLI), opens browser for OAuth.
   *                    When false (daemon), logs a message instead.
   */
  constructor(serverId: string, serverUrl: string, interactive = false) {
    this.serverId = serverId;
    this.serverUrl = serverUrl;
    this.interactive = interactive;
  }

  // --- redirectUrl ---

  get redirectUrl(): string | undefined {
    return this._redirectUrl;
  }

  // --- clientMetadata ---

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Vellum Assistant",
      redirect_uris: this._redirectUrl ? [this._redirectUrl] : [],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
  }

  // --- Tokens ---

  async tokens(): Promise<OAuthTokens | undefined> {
    const raw = await getSecureKeyAsync(tokensKey(this.serverId));
    if (!raw) return undefined;
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
    const ok = await setSecureKeyAsync(
      tokensKey(this.serverId),
      JSON.stringify(tokens),
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

  // --- Client Information ---

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const raw = await getSecureKeyAsync(clientInfoKey(this.serverId));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as OAuthClientInformationMixed;
    } catch {
      log.warn(
        { serverId: this.serverId },
        "Failed to parse stored client information",
      );
      return undefined;
    }
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
    log.info({ serverId: this.serverId }, "OAuth client information saved");
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

  // --- Discovery State ---

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const raw = await getSecureKeyAsync(discoveryKey(this.serverId));
    if (!raw) return undefined;
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
    }
    if (scope === "all" || scope === "verifier") {
      this._codeVerifier = undefined;
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

  // --- Callback Server ---

  /**
   * Start a loopback HTTP server to receive the OAuth callback.
   * Returns a promise that resolves with the authorization code.
   */
  startCallbackServer(): Promise<McpOAuthCallbackResult> {
    return new Promise((resolveSetup, rejectSetup) => {
      let settled = false;
      let listening = false;
      let codeResolve: (code: string) => void;
      let codeReject: (err: Error) => void;

      const codePromise = new Promise<string>((resolve, reject) => {
        codeResolve = resolve;
        codeReject = reject;
      });
      this._codePromise = codePromise;

      const server = createServer((req, res) => {
        if (settled) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(renderPage("Authorization already completed", false));
          return;
        }

        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== CALLBACK_PATH) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
          return;
        }

        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        settled = true;

        if (error) {
          const errorDesc = url.searchParams.get("error_description") ?? error;
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(renderPage(`Authorization failed: ${errorDesc}`, false));
          cleanup();
          codeReject(new Error(`MCP OAuth authorization denied: ${error}`));
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(renderPage("Missing authorization code", false));
          cleanup();
          codeReject(
            new Error("MCP OAuth callback missing authorization code"),
          );
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          renderPage("Authorization successful! You can close this tab.", true),
        );
        cleanup();
        codeResolve(code);
      });

      this.callbackServer = server;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          codeReject(new Error("MCP OAuth callback timed out"));
        }
      }, CALLBACK_TIMEOUT_MS);
      if (typeof timeout === "object" && "unref" in timeout) timeout.unref();
      this.callbackTimeout = timeout;

      const cleanup = () => {
        if (this.callbackTimeout) {
          clearTimeout(this.callbackTimeout);
          this.callbackTimeout = null;
        }
        if (this.callbackServer) {
          this.callbackServer.close();
          this.callbackServer = null;
        }
      };

      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        this._redirectUrl = `http://127.0.0.1:${addr.port}${CALLBACK_PATH}`;
        listening = true;
        log.info(
          { serverId: this.serverId, redirectUrl: this._redirectUrl },
          "OAuth callback server started",
        );
        resolveSetup({ codePromise });
      });

      server.on("error", (err) => {
        const message = `MCP OAuth callback server error: ${err.message}`;
        if (!listening) {
          settled = true;
          cleanup();
          rejectSetup(new Error(message));
        } else if (!settled) {
          settled = true;
          cleanup();
          codeReject(new Error(message));
        }
      });
    });
  }

  /** Returns the code promise from the running callback server. */
  waitForCode(): Promise<string> {
    if (!this._codePromise) {
      throw new Error(
        "Callback server not started — call startCallbackServer() first",
      );
    }
    return this._codePromise;
  }

  /** Stop the callback server if it's still running. */
  stopCallbackServer(): void {
    if (this.callbackTimeout) {
      clearTimeout(this.callbackTimeout);
      this.callbackTimeout = null;
    }
    if (this.callbackServer) {
      this.callbackServer.close();
      this.callbackServer = null;
    }
  }
}

// --- Static helpers ---

/**
 * Delete all OAuth credentials for a given MCP server.
 * Used by `mcp remove` for cleanup.
 */
export async function deleteMcpOAuthCredentials(
  serverId: string,
): Promise<void> {
  const [tokensResult, clientResult, discoveryResult] = await Promise.all([
    deleteSecureKeyAsync(tokensKey(serverId)),
    deleteSecureKeyAsync(clientInfoKey(serverId)),
    deleteSecureKeyAsync(discoveryKey(serverId)),
  ]);
  const results = [
    { key: "tokens", result: tokensResult },
    { key: "client_info", result: clientResult },
    { key: "discovery", result: discoveryResult },
  ];
  const errors = results.filter((r) => r.result === "error").map((r) => r.key);
  if (errors.length > 0) {
    log.warn(
      { serverId, failedKeys: errors },
      "Some OAuth credentials could not be deleted from secure storage",
    );
  }
  const hasErrors = errors.length > 0;
  log.info(
    { serverId },
    hasErrors
      ? "OAuth credential deletion completed with errors"
      : "OAuth credentials deleted",
  );
}

// --- HTML rendering ---

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderPage(message: string, success: boolean): string {
  const title = success ? "Authorization Successful" : "Authorization Failed";
  const color = success ? "#4CAF50" : "#f44336";
  return `<!DOCTYPE html><html><head><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5}div{text-align:center;padding:2rem;background:white;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1)}h1{color:${color}}</style></head><body><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div></body></html>`;
}
