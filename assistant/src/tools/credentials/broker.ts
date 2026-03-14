import { v4 as uuid } from "uuid";

import { credentialKey } from "../../security/credential-key.js";
import { getSecureKeyAsync } from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";
import type {
  AuthorizeRequest,
  AuthorizeResult,
  BrowserFillRequest,
  BrowserFillResult,
  ConsumeResult,
  ServerUseByIdRequest,
  ServerUseByIdResult,
  ServerUseRequest,
  ServerUseResult,
  UsageToken,
} from "./broker-types.js";
import { isDomainAllowed } from "./domain-policy.js";
import { getCredentialMetadata } from "./metadata-store.js";
import { resolveById } from "./resolve.js";
import { isToolAllowed } from "./tool-policy.js";

const log = getLogger("credential-broker");

/** Tokens expire after 5 minutes to limit the window for using stale/revoked credentials. */
const TOKEN_TTL_MS = 5 * 60 * 1000;

/**
 * Credential broker that issues single-use tokens for policy-checked credential access.
 *
 * The broker never exposes plaintext secret values. Instead, it:
 * 1. Checks that a credential exists and has metadata
 * 2. Issues a single-use token for the authorized usage
 * 3. On consumption, returns the storage key so the caller can read the secret internally
 *
 * Tool policy is enforced at authorize/fill time; domain policy is enforced at fill time.
 */
export class CredentialBroker {
  private tokens = new Map<string, UsageToken>();
  /** Transient values for one-time send: consumed on first read, never persisted.
   *  Values are wrapped in objects so post-await guards use reference identity
   *  (not string value equality) to detect concurrent replacements. */
  private transientValues = new Map<string, { value: string }>();

  /**
   * Inject a value for one-time use. The value is consumed on the next
   * browserFill or consume call for this service/field pair, then discarded.
   */
  injectTransient(service: string, field: string, value: string): void {
    const key = credentialKey(service, field);
    this.transientValues.set(key, { value });
    log.info(
      { service, field },
      "Transient credential injected for one-time use",
    );
  }

  /**
   * Authorize the use of a credential for a specific tool and optional domain.
   * Returns a single-use token on success, or a denial reason on failure.
   */
  authorize(request: AuthorizeRequest): AuthorizeResult {
    const metadata = getCredentialMetadata(request.service, request.field);
    if (!metadata) {
      return {
        authorized: false,
        reason: `No credential found for ${request.service}/${request.field}`,
      };
    }

    // Tool policy enforcement — deny if tool is not in the credential's allowed list
    if (!isToolAllowed(request.toolName, metadata.allowedTools)) {
      const tools = metadata.allowedTools ?? [];
      return {
        authorized: false,
        reason:
          `Tool "${request.toolName}" is not allowed to use credential ${request.service}/${request.field}. ` +
          (tools.length === 0
            ? "No tools are currently allowed — update the credential with allowed_tools via credential_store."
            : `Allowed tools: ${tools.join(", ")}.`),
      };
    }

    const token: UsageToken = {
      tokenId: uuid(),
      credentialId: metadata.credentialId,
      service: request.service,
      field: request.field,
      toolName: request.toolName,
      createdAt: Date.now(),
      consumed: false,
    };

    this.tokens.set(token.tokenId, token);
    log.info(
      {
        tokenId: token.tokenId,
        service: request.service,
        field: request.field,
        tool: request.toolName,
      },
      "Usage token issued",
    );

    return { authorized: true, token: { ...token } };
  }

  /**
   * Consume a previously issued token. Returns the storage key on success.
   * Each token can only be consumed once.
   */
  consume(tokenId: string): ConsumeResult {
    const token = this.tokens.get(tokenId);
    if (!token) {
      return { success: false, reason: "Token not found or already revoked" };
    }
    if (token.consumed) {
      return { success: false, reason: "Token already consumed" };
    }
    if (Date.now() - token.createdAt > TOKEN_TTL_MS) {
      this.tokens.delete(tokenId);
      log.info({ tokenId }, "Token expired (TTL exceeded)");
      return { success: false, reason: "Token expired" };
    }

    token.consumed = true;
    const storageKey = credentialKey(token.service, token.field);
    // Check for transient value first (one-time send) — consume and return the value
    // directly since transient values are never persisted to secure storage.
    const transient = this.transientValues.get(storageKey);
    if (transient !== undefined) {
      this.transientValues.delete(storageKey);
      log.info(
        { tokenId, storageKey, transient: true },
        "Usage token consumed (transient)",
      );
      return { success: true, storageKey, value: transient.value };
    }

    log.info({ tokenId, storageKey }, "Usage token consumed");
    return { success: true, storageKey };
  }

  /**
   * Revoke a token, removing it from the active set.
   * Returns true if the token existed and was revoked.
   */
  revoke(tokenId: string): boolean {
    const existed = this.tokens.delete(tokenId);
    if (existed) {
      log.info({ tokenId }, "Usage token revoked");
    }
    return existed;
  }

  /** Revoke all tokens (e.g. on session teardown). */
  revokeAll(): void {
    const count = this.tokens.size;
    this.tokens.clear();
    if (count > 0) {
      log.info({ count }, "All usage tokens revoked");
    }
  }

  /**
   * Fill a browser field using a credential without exposing plaintext to the caller.
   *
   * The broker resolves the credential, reads the secret internally, and passes it
   * to the provided fill callback. The return value contains only metadata — the
   * plaintext never leaves this method's scope.
   */
  async browserFill(request: BrowserFillRequest): Promise<BrowserFillResult> {
    const metadata = getCredentialMetadata(request.service, request.field);
    if (!metadata) {
      return {
        success: false,
        reason: `No credential found for ${request.service}/${request.field}`,
      };
    }

    // Tool policy enforcement — deny if tool is not in the credential's allowed list
    if (!isToolAllowed(request.toolName, metadata.allowedTools)) {
      const tools = metadata.allowedTools ?? [];
      return {
        success: false,
        reason:
          `Tool "${request.toolName}" is not allowed to use credential ${request.service}/${request.field}. ` +
          (tools.length === 0
            ? "No tools are currently allowed — update the credential with allowed_tools via credential_store."
            : `Allowed tools: ${tools.join(", ")}.`),
      };
    }

    // Domain policy enforcement — deny if the page domain is not in the credential's allowed list
    const browserDomains = metadata.allowedDomains ?? [];
    if (browserDomains.length > 0) {
      if (!request.domain) {
        return {
          success: false,
          reason:
            `Credential ${request.service}/${request.field} has a domain policy but no page domain was provided. ` +
            `Allowed domains: ${browserDomains.join(", ")}.`,
        };
      }
      if (!isDomainAllowed(request.domain, browserDomains)) {
        return {
          success: false,
          reason:
            `Domain "${request.domain}" is not allowed for credential ${request.service}/${request.field}. ` +
            `Allowed domains: ${browserDomains.join(", ")}.`,
        };
      }
    }

    const storageKey = credentialKey(request.service, request.field);
    // Check transient values first (one-time send), then fall back to keychain.
    // Deletion is deferred until after a successful fill so the value survives
    // transient failures (e.g. stale element, page navigation, Playwright timeout).
    const transient = this.transientValues.get(storageKey);
    const value = transient?.value ?? (await getSecureKeyAsync(storageKey));
    if (!value) {
      return {
        success: false,
        reason: `Credential metadata exists but no stored value for ${request.service}/${request.field}`,
      };
    }

    try {
      await request.fill(value);
      // Only discard the transient value after a successful fill, and only if
      // the map still holds the same reference — a concurrent injectTransient()
      // call during the async fill could have replaced it with a new value.
      if (
        transient !== undefined &&
        this.transientValues.get(storageKey) === transient
      ) {
        this.transientValues.delete(storageKey);
      }
      log.info(
        {
          service: request.service,
          field: request.field,
          tool: request.toolName,
        },
        "Browser fill completed",
      );
      return { success: true };
    } catch (err) {
      // Log the raw error for debugging but never return it — the callback
      // error text may embed the credential value, leaking plaintext outside
      // the broker's trust boundary.
      log.error(
        { err, service: request.service, field: request.field },
        "Browser fill failed",
      );
      return { success: false, reason: "Fill operation failed" };
    }
  }

  /**
   * Use a credential server-side without exposing plaintext to the caller.
   *
   * Like browserFill, the broker reads the secret internally and passes it
   * to the provided callback. The return value contains only the callback's
   * result — the plaintext never leaves this method's scope.
   */
  async serverUse<T>(
    request: ServerUseRequest<T>,
  ): Promise<ServerUseResult<T>> {
    const metadata = getCredentialMetadata(request.service, request.field);
    if (!metadata) {
      return {
        success: false,
        reason: `No credential found for ${request.service}/${request.field}`,
      };
    }

    if (!isToolAllowed(request.toolName, metadata.allowedTools)) {
      const tools = metadata.allowedTools ?? [];
      return {
        success: false,
        reason:
          `Tool "${request.toolName}" is not allowed to use credential ${request.service}/${request.field}. ` +
          (tools.length === 0
            ? "No tools are currently allowed — update the credential with allowed_tools via credential_store."
            : `Allowed tools: ${tools.join(", ")}.`),
      };
    }

    // Domain policy enforcement — credentials with domain restrictions are
    // scoped to browser use on those domains and cannot be used server-side.
    const serverDomains = metadata.allowedDomains ?? [];
    if (serverDomains.length > 0) {
      return {
        success: false,
        reason:
          `Credential ${request.service}/${request.field} has domain restrictions ` +
          `(${serverDomains.join(", ")}) and cannot be used server-side. ` +
          "Remove domain restrictions or use a separate credential without domain policy.",
      };
    }

    const storageKey = credentialKey(request.service, request.field);
    const transient = this.transientValues.get(storageKey);
    const value = transient?.value ?? (await getSecureKeyAsync(storageKey));
    if (!value) {
      return {
        success: false,
        reason: `Credential metadata exists but no stored value for ${request.service}/${request.field}`,
      };
    }

    try {
      const result = await request.execute(value);
      if (
        transient !== undefined &&
        this.transientValues.get(storageKey) === transient
      ) {
        this.transientValues.delete(storageKey);
      }
      log.info(
        {
          service: request.service,
          field: request.field,
          tool: request.toolName,
        },
        "Server-side credential use completed",
      );
      return { success: true, result };
    } catch (err) {
      log.error(
        { err, service: request.service, field: request.field },
        "Server-side credential use failed",
      );
      return { success: false, reason: "Credential use failed" };
    }
  }

  /**
   * Look up a credential by its opaque ID for proxy injection.
   *
   * Returns metadata and injection templates so the proxy knows how to
   * inject the credential into outbound requests. The secret value is
   * never included in the result — the proxy reads it separately via
   * the secure key backend at injection time.
   */
  async serverUseById(
    request: ServerUseByIdRequest,
  ): Promise<ServerUseByIdResult> {
    const resolved = resolveById(request.credentialId);
    if (!resolved) {
      return {
        success: false,
        reason: `No credential found for id "${request.credentialId}"`,
      };
    }

    const { metadata } = resolved;

    // Tool policy enforcement
    if (!isToolAllowed(request.requestingTool, metadata.allowedTools)) {
      const tools = metadata.allowedTools ?? [];
      return {
        success: false,
        reason:
          `Tool "${request.requestingTool}" is not allowed to use credential ${metadata.service}/${metadata.field}. ` +
          (tools.length === 0
            ? "No tools are currently allowed — update the credential with allowed_tools via credential_store."
            : `Allowed tools: ${tools.join(", ")}.`),
      };
    }

    // Domain policy enforcement — credentials with domain restrictions are
    // scoped to browser use on those domains and cannot be used server-side.
    const domains = metadata.allowedDomains ?? [];
    if (domains.length > 0) {
      return {
        success: false,
        reason:
          `Credential ${metadata.service}/${metadata.field} has domain restrictions ` +
          `(${domains.join(", ")}) and cannot be used server-side. ` +
          "Remove domain restrictions or use a separate credential without domain policy.",
      };
    }

    // Fail-closed: verify the secret value actually exists in secure storage.
    // Without this, downstream proxy code would attempt unauthenticated requests.
    const value = await getSecureKeyAsync(resolved.storageKey);
    if (!value) {
      return {
        success: false,
        reason: `Credential metadata exists but no stored value for ${metadata.service}/${metadata.field}`,
      };
    }

    log.info(
      {
        credentialId: request.credentialId,
        service: metadata.service,
        field: metadata.field,
        tool: request.requestingTool,
      },
      "Server-side credential lookup by ID completed",
    );

    return {
      success: true,
      credentialId: resolved.credentialId,
      service: resolved.service,
      field: resolved.field,
      injectionTemplates: resolved.injectionTemplates,
    };
  }

  /** Return the number of active (non-consumed, non-revoked, non-expired) tokens. */
  get activeTokenCount(): number {
    const now = Date.now();
    let count = 0;
    for (const token of this.tokens.values()) {
      if (!token.consumed && now - token.createdAt <= TOKEN_TTL_MS) count++;
    }
    return count;
  }
}

/** Shared singleton broker instance used by vault and browser tools. */
export const credentialBroker = new CredentialBroker();
