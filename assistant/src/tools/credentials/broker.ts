import { credentialKey } from "../../security/credential-key.js";
import { getSecureKeyAsync } from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";
import type {
  BrowserFillRequest,
  BrowserFillResult,
  ServerUseRequest,
  ServerUseResult,
} from "./broker-types.js";
import { isDomainAllowed } from "./domain-policy.js";
import { getCredentialMetadata } from "./metadata-store.js";
import {
  isToolAllowed,
  serverUseDenialReason,
  toolNotAllowedReason,
} from "./tool-policy.js";

const log = getLogger("credential-broker");

/**
 * Credential broker that mediates policy-checked credential access.
 *
 * The broker never exposes plaintext secret values to callers. It:
 * 1. Checks that a credential exists and has metadata
 * 2. Enforces tool and domain policy
 * 3. Reads the secret internally and passes it to an opaque callback
 *
 * Tool policy is enforced at fill/use time; domain policy is enforced at fill time.
 */
export class CredentialBroker {
  /** Transient values for one-time send: consumed on first read, never persisted.
   *  Values are wrapped in objects so post-await guards use reference identity
   *  (not string value equality) to detect concurrent replacements. */
  private transientValues = new Map<string, { value: string }>();

  /**
   * Inject a value for one-time use. The value is consumed on the next
   * browserFill or serverUse call for this service/field pair, then discarded.
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
   * Fill a browser field using a credential without exposing plaintext to the caller.
   *
   * The broker resolves the credential, reads the secret internally, and passes it
   * to the provided fill callback. The return value contains only metadata - the
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

    // Tool policy enforcement - deny if tool is not in the credential's allowed list
    if (!isToolAllowed(request.toolName, metadata.allowedTools)) {
      return {
        success: false,
        reason: toolNotAllowedReason(
          request.toolName,
          request.service,
          request.field,
          metadata.allowedTools,
        ),
      };
    }

    // Domain policy enforcement - deny if the page domain is not in the credential's allowed list
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
    // Check transient values first (one-time send), then fall back to credential store.
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
      // the map still holds the same reference - a concurrent injectTransient()
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
      // Log the raw error for debugging but never return it - the callback
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
   * result - the plaintext never leaves this method's scope.
   */
  async serverUse<T>(
    request: ServerUseRequest<T>,
  ): Promise<ServerUseResult<T>> {
    const metadata = getCredentialMetadata(request.service, request.field);
    const denialReason = serverUseDenialReason(
      metadata,
      request.toolName,
      request.service,
      request.field,
    );
    if (denialReason) {
      return { success: false, reason: denialReason };
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
}

/** Shared singleton broker instance used by vault and browser tools. */
export const credentialBroker = new CredentialBroker();
