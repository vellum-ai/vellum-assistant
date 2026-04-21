/**
 * Web risk classifier — domain and method-based risk classification.
 *
 * Implements RiskClassifier<WebClassifierInput> for web-related tools:
 * web_search, web_fetch, and network_request. Replicates the exact logic
 * from checker.ts classifyRiskUncached() lines 472-482.
 *
 * - web_search: always Low (read-only)
 * - web_fetch: High if allowPrivateNetwork, Low otherwise
 * - network_request: always Medium (proxied credentials)
 */

import type { RiskAssessment, RiskClassifier } from "./risk-types.js";
import type { AllowlistOption } from "./types.js";

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

// ── Allowlist option helpers ─────────────────────────────────────────────────

const WEB_TOOL_DISPLAY_NAMES: Record<string, string> = {
  web_fetch: "URL fetches",
  network_request: "network requests",
};

function escapeMinimatchLiteral(value: string): string {
  return value.replace(/([\\*?[\]{}()!+@|])/g, "\\$1");
}

function friendlyHostname(url: URL): string {
  return url.hostname.replace(/^www\./, "");
}

/**
 * Normalize a URL for allowlist purposes. Mirrors the canonicalization
 * logic in checker.ts `normalizeWebFetchUrl()`.
 */
function normalizeUrl(rawUrl: string): URL | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      parsed.hash = "";
      parsed.username = "";
      parsed.password = "";
      try {
        parsed.pathname = decodeURI(parsed.pathname);
      } catch {
        // Keep canonical form when decoding fails.
      }
      if (parsed.hostname.endsWith(".")) {
        parsed.hostname = parsed.hostname.replace(/\.+$/, "");
      }
      return parsed;
    }
  } catch {
    // Fall through.
  }

  try {
    const parsed = new URL(`https://${trimmed}`);
    parsed.hash = "";
    parsed.username = "";
    parsed.password = "";
    if (parsed.hostname.endsWith(".")) {
      parsed.hostname = parsed.hostname.replace(/\.+$/, "");
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Build allowlist options for a web tool invocation, mirroring the logic
 * in checker.ts `urlAllowlistStrategy()`. Options go from most specific
 * (exact URL) to broadest (all fetches of this tool type).
 */
function buildWebAllowlistOptions(
  toolName: string,
  rawUrl?: string,
): AllowlistOption[] {
  if (!rawUrl) return [];

  const normalized = normalizeUrl(rawUrl);
  const exact = normalized?.href ?? rawUrl;
  const toolLabel = WEB_TOOL_DISPLAY_NAMES[toolName] ?? toolName;

  const options: AllowlistOption[] = [];
  if (exact) {
    options.push({
      label: exact,
      description: "This exact URL",
      pattern: `${toolName}:${escapeMinimatchLiteral(exact)}`,
    });
  }
  if (normalized) {
    const host = friendlyHostname(normalized);
    options.push({
      label: `${normalized.origin}/*`,
      description: `Any page on ${host}`,
      pattern: `${toolName}:${escapeMinimatchLiteral(normalized.origin)}/*`,
    });
  }
  // Use standalone "**" globstar — minimatch only treats ** as globstar when
  // it is its own path segment, so "${toolName}:*" would fail to match URL
  // candidates containing "/". The tool field is already filtered separately.
  options.push({
    label: `${toolName}:*`,
    description: `All ${toolLabel}`,
    pattern: "**",
  });

  const seen = new Set<string>();
  return options.filter((o) => {
    if (seen.has(o.pattern)) return false;
    seen.add(o.pattern);
    return true;
  });
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
    const { toolName, url, allowPrivateNetwork } = input;
    const allowlistOptions = buildWebAllowlistOptions(toolName, url);

    switch (toolName) {
      case "web_search":
        return {
          riskLevel: "low",
          reason: "Web search (read-only)",
          scopeOptions: [],
          matchType: "registry",
          allowlistOptions,
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
            allowlistOptions,
          };
        }
        return {
          riskLevel: "low",
          reason: "Web fetch (default)",
          scopeOptions: [],
          matchType: "registry",
          allowlistOptions,
        };

      case "network_request":
        // Proxy-authenticated network requests are Medium risk — they carry
        // injected credentials and the user should approve the target host/origin.
        return {
          riskLevel: "medium",
          reason: "Network request (proxied credentials)",
          scopeOptions: [],
          matchType: "registry",
          allowlistOptions,
        };
    }
  }
}

/** Singleton classifier instance. */
export const webRiskClassifier = new WebRiskClassifier();
