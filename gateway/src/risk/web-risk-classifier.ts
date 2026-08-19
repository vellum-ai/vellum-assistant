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

import { normalizeWebUrl } from "@vellumai/service-contracts/url-normalization";

import type {
  AllowlistOption,
  RiskAssessment,
  RiskClassifier,
} from "./risk-types.js";
import { getTrustRuleCache } from "./trust-rule-cache.js";
import { applyUserRuleOverride } from "./user-rule-override.js";

// -- Input type ---------------------------------------------------------------

/** Input to the web risk classifier. */
export interface WebClassifierInput {
  /** Which web tool is being invoked. */
  toolName: "web_fetch" | "network_request" | "web_search";
  /** The target URL (informational, not used for classification yet). */
  url?: string;
  /** Whether the fetch is allowed to reach private/internal networks. */
  allowPrivateNetwork?: boolean;
}

// -- Allowlist ladder ---------------------------------------------------------

const WEB_TOOL_DISPLAY_NAMES: Record<string, string> = {
  web_fetch: "URL fetches",
  network_request: "network requests",
};

/** Hostname as a person reads it. */
function friendlyHostname(url: URL): string {
  return url.hostname.replace(/^www\./, "");
}

/**
 * The "always allow" ladder for a web tool: this exact URL, anything on the
 * origin, then the tool as a whole.
 *
 * Patterns are the URL verbatim: a rule is matched by exact string
 * (`TrustRuleCache.findToolOverride`), so anything done to the pattern that
 * is not also done to the lookup key produces a rule that cannot fire.
 *
 * The URL is normalized through the shared canonicalizer
 * (`@vellumai/service-contracts/url-normalization`), so the saved pattern has
 * one spelling rather than whichever the model wrote. Lookup does not
 * normalize, so a saved rule matches only an invocation already written in
 * canonical form.
 */
function buildWebAllowlistOptions(
  toolName: string,
  rawUrl: string,
): AllowlistOption[] {
  const trimmed = rawUrl.trim();
  const normalized = normalizeWebUrl(trimmed);
  const exact = normalized?.href ?? trimmed;

  const options: AllowlistOption[] = [];
  if (exact) {
    options.push({
      label: exact,
      description: "This exact URL",
      pattern: `${toolName}:${exact}`,
    });
  }
  if (normalized) {
    options.push({
      label: `${normalized.origin}/*`,
      description: `Any page on ${friendlyHostname(normalized)}`,
      pattern: `${toolName}:${normalized.origin}/*`,
    });
  }
  // A standalone globstar: Minimatch only treats `**` as a globstar when it is
  // its own path segment, so `${toolName}:*` would fail to match a candidate
  // containing `/`. The tool field is matched separately.
  options.push({
    label: `${toolName}:*`,
    description: `All ${WEB_TOOL_DISPLAY_NAMES[toolName] ?? toolName}`,
    pattern: `**`,
  });

  const seen = new Set<string>();
  return options.filter((option) => {
    if (seen.has(option.pattern)) {
      return false;
    }
    seen.add(option.pattern);
    return true;
  });
}

// -- Classifier ---------------------------------------------------------------

/**
 * Web risk classifier implementation.
 *
 * Classifies web tool invocations by tool type and flags. This is the
 * simplest classifier — no registry lookups, no subcommand resolution,
 * just direct conditional logic matching the original checker.ts behavior.
 */
export class WebRiskClassifier implements RiskClassifier<WebClassifierInput> {
  async classify(input: WebClassifierInput): Promise<RiskAssessment> {
    const { toolName, url, allowPrivateNetwork } = input;

    // `web_search` takes no URL, so it carries no ladder: a saved rule would
    // have nothing to scope to.
    const allowlistOptions =
      toolName === "web_search"
        ? undefined
        : buildWebAllowlistOptions(toolName, url ?? "");

    // Run normal classification first (including security escalations like
    // allowPrivateNetwork), then check for user overrides at the end. Note
    // that user overrides are applied unconditionally, so a user-defined rule
    // CAN lower a security-escalated risk. This is intentional.
    let assessment: RiskAssessment;

    switch (toolName) {
      case "web_search":
        assessment = {
          riskLevel: "low",
          reason: "Web search (read-only)",
          scopeOptions: [],
          matchType: "registry",
        };
        break;

      case "web_fetch":
        // Private-network fetches are High risk so that blanket allow rules
        // (including the starter bundle) cannot silently bypass the prompt.
        if (allowPrivateNetwork === true) {
          assessment = {
            riskLevel: "high",
            reason: "Private network fetch",
            scopeOptions: [],
            allowlistOptions,
            matchType: "registry",
          };
        } else {
          assessment = {
            riskLevel: "low",
            reason: "Web fetch (default)",
            scopeOptions: [],
            allowlistOptions,
            matchType: "registry",
          };
        }
        break;

      case "network_request":
        // Proxy-authenticated network requests are Medium risk — they carry
        // injected credentials and the user should approve the target host/origin.
        assessment = {
          riskLevel: "medium",
          reason: "Network request (proxied credentials)",
          scopeOptions: [],
          allowlistOptions,
          matchType: "registry",
        };
        break;
    }

    // User override is applied after normal classification. This means a user-defined
    // rule CAN lower a security-escalated risk (e.g., allowPrivateNetwork fetch).
    // This is intentional — user overrides are authoritative for users who explicitly
    // created them.
    try {
      const ruleCache = getTrustRuleCache();
      const override = ruleCache.findToolOverride(toolName, url ?? "");
      if (
        override &&
        (override.userModified || override.origin === "user_defined")
      ) {
        return applyUserRuleOverride(assessment!, override);
      }
    } catch {
      // Cache not initialized — no override
    }

    return assessment!;
  }
}

/** Singleton classifier instance. */
export const webRiskClassifier = new WebRiskClassifier();
