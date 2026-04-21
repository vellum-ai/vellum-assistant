/**
 * Web risk classifier — domain and method-based risk classification.
 *
 * Implements RiskClassifier<WebClassifierInput> for web-related tools:
 * web_search, web_fetch, and network_request.
 *
 * - web_search: always Low (read-only)
 * - web_fetch: High if allowPrivateNetwork, Low otherwise
 * - network_request: always Medium (proxied credentials)
 */

import type { RiskAssessment, RiskClassifier } from "./risk-types.js";

// ── Input type ───────────────────────────────────────────────────────────────

/** Input to the web risk classifier. */
export interface WebClassifierInput {
  /** Which web tool is being invoked. */
  toolName: "web_fetch" | "network_request" | "web_search";
  /** The target URL (informational, not used for classification yet). */
  url?: string;
  /** Whether the fetch is allowed to reach private/internal networks. */
  allowPrivateNetwork?: boolean;
}

// ── Classifier ───────────────────────────────────────────────────────────────

/**
 * Web risk classifier implementation.
 *
 * Classifies web tool invocations by tool type and flags. This is the
 * simplest classifier — no registry lookups, no subcommand resolution,
 * just direct conditional logic matching the original checker.ts behavior.
 */
export class WebRiskClassifier implements RiskClassifier<WebClassifierInput> {
  async classify(input: WebClassifierInput): Promise<RiskAssessment> {
    const { toolName, allowPrivateNetwork } = input;

    // NOTE: We intentionally do NOT produce allowlistOptions here.
    // The canonical URL normalization logic (normalizeWebFetchUrl in
    // checker.ts) handles edge cases (path-only inputs, host:port
    // shorthand, non-http schemes) that our simplified normalizeUrl()
    // does not. Importing the canonical version would create a circular
    // dependency. By omitting allowlistOptions, we let the fallback
    // urlAllowlistStrategy in generateAllowlistOptions() handle scope
    // option generation using the canonical normalization.

    switch (toolName) {
      case "web_search":
        return {
          riskLevel: "low",
          reason: "Web search (read-only)",
          scopeOptions: [],
          matchType: "registry",
        };

      case "web_fetch":
        // Private-network fetches are High risk so that blanket allow rules
        // (including the starter bundle) cannot silently bypass the prompt.
        if (allowPrivateNetwork === true) {
          return {
            riskLevel: "high",
            reason: "Private network fetch",
            scopeOptions: [],
            matchType: "registry",
          };
        }
        return {
          riskLevel: "low",
          reason: "Web fetch (default)",
          scopeOptions: [],
          matchType: "registry",
        };

      case "network_request":
        // Proxy-authenticated network requests are Medium risk — they carry
        // injected credentials and the user should approve the target host/origin.
        return {
          riskLevel: "medium",
          reason: "Network request (proxied credentials)",
          scopeOptions: [],
          matchType: "registry",
        };
    }
  }
}

/** Singleton classifier instance. */
export const webRiskClassifier = new WebRiskClassifier();
