import { v4 as uuid } from 'uuid';
import type {
  AuthorizeRequest,
  AuthorizeResult,
  BrowserFillRequest,
  BrowserFillResult,
  ConsumeResult,
  UsageToken,
} from './broker-types.js';
import { getCredentialMetadata } from './metadata-store.js';
import { isToolAllowed } from './tool-policy.js';
import { isDomainAllowed } from './domain-policy.js';
import { getSecureKey } from '../../security/secure-keys.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('credential-broker');

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
      return {
        authorized: false,
        reason: `Tool "${request.toolName}" is not allowed to use credential ${request.service}/${request.field}. ` +
          (metadata.allowedTools.length === 0
            ? 'No tools are currently allowed — update the credential with allowed_tools via credential_store.'
            : `Allowed tools: ${metadata.allowedTools.join(', ')}.`),
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
    log.info({ tokenId: token.tokenId, service: request.service, field: request.field, tool: request.toolName },
      'Usage token issued');

    return { authorized: true, token };
  }

  /**
   * Consume a previously issued token. Returns the storage key on success.
   * Each token can only be consumed once.
   */
  consume(tokenId: string): ConsumeResult {
    const token = this.tokens.get(tokenId);
    if (!token) {
      return { success: false, reason: 'Token not found or already revoked' };
    }
    if (token.consumed) {
      return { success: false, reason: 'Token already consumed' };
    }

    token.consumed = true;
    const storageKey = `credential:${token.service}:${token.field}`;
    log.info({ tokenId, storageKey }, 'Usage token consumed');

    return { success: true, storageKey };
  }

  /**
   * Revoke a token, removing it from the active set.
   * Returns true if the token existed and was revoked.
   */
  revoke(tokenId: string): boolean {
    const existed = this.tokens.delete(tokenId);
    if (existed) {
      log.info({ tokenId }, 'Usage token revoked');
    }
    return existed;
  }

  /** Revoke all tokens (e.g. on session teardown). */
  revokeAll(): void {
    const count = this.tokens.size;
    this.tokens.clear();
    if (count > 0) {
      log.info({ count }, 'All usage tokens revoked');
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
      return {
        success: false,
        reason: `Tool "${request.toolName}" is not allowed to use credential ${request.service}/${request.field}. ` +
          (metadata.allowedTools.length === 0
            ? 'No tools are currently allowed — update the credential with allowed_tools via credential_store.'
            : `Allowed tools: ${metadata.allowedTools.join(', ')}.`),
      };
    }

    // Domain policy enforcement — deny if the page domain is not in the credential's allowed list
    if (metadata.allowedDomains.length > 0) {
      if (!request.domain) {
        return {
          success: false,
          reason: `Credential ${request.service}/${request.field} has a domain policy but no page domain was provided. ` +
            `Allowed domains: ${metadata.allowedDomains.join(', ')}.`,
        };
      }
      if (!isDomainAllowed(request.domain, metadata.allowedDomains)) {
        return {
          success: false,
          reason: `Domain "${request.domain}" is not allowed for credential ${request.service}/${request.field}. ` +
            `Allowed domains: ${metadata.allowedDomains.join(', ')}.`,
        };
      }
    }

    const value = getSecureKey(`credential:${request.service}:${request.field}`);
    if (!value) {
      return {
        success: false,
        reason: `Credential metadata exists but no stored value for ${request.service}/${request.field}`,
      };
    }

    try {
      await request.fill(value);
      log.info(
        { service: request.service, field: request.field, tool: request.toolName },
        'Browser fill completed',
      );
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err, service: request.service, field: request.field },
        'Browser fill failed',
      );
      return { success: false, reason: `Fill operation failed: ${msg}` };
    }
  }

  /** Return the number of active (non-consumed, non-revoked) tokens. */
  get activeTokenCount(): number {
    let count = 0;
    for (const token of this.tokens.values()) {
      if (!token.consumed) count++;
    }
    return count;
  }
}
