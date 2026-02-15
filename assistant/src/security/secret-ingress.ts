import { getConfig } from '../config/loader.js';
import { scanText } from './secret-scanner.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('secret-ingress');

export interface IngressCheckResult {
  /** Whether the message should be blocked from entering the model context. */
  blocked: boolean;
  /** Secret types detected (empty if none). */
  detectedTypes: string[];
  /**
   * User-facing notice explaining why the message was blocked.
   * Does NOT echo the secret value — only describes what was found.
   */
  userNotice?: string;
}

/**
 * Scan inbound user text for secrets before it enters model context.
 *
 * When `secretDetection.action` is `block` (default), any message containing
 * a detected secret is rejected with a safe notice. The raw message content
 * is never logged or persisted.
 *
 * SECURITY: This function intentionally never logs the message content.
 */
export function checkIngressForSecrets(content: string): IngressCheckResult {
  const config = getConfig();
  if (!config.secretDetection.enabled) {
    return { blocked: false, detectedTypes: [] };
  }

  // Only block in 'block' mode; 'warn' and 'redact' apply to tool output, not user input
  if (config.secretDetection.action !== 'block') {
    return { blocked: false, detectedTypes: [] };
  }

  const matches = scanText(content);

  if (matches.length === 0) {
    return { blocked: false, detectedTypes: [] };
  }

  const detectedTypes = [...new Set(matches.map((m) => m.type))];
  log.warn({ detectedTypes, matchCount: matches.length }, 'Blocked inbound message containing secrets');

  return {
    blocked: true,
    detectedTypes,
    userNotice:
      `Your message appears to contain sensitive information (${detectedTypes.join(', ')}). ` +
      `For security, it was not sent to the AI. ` +
      `Please use the secure credential prompt instead — the assistant will ask for secrets when it needs them.`,
  };
}
