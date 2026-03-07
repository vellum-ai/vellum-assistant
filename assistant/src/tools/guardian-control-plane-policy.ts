/**
 * Guardian control-plane policy \u2014 deterministic gate that prevents non-guardian
 * and unverified_channel actors from invoking guardian verification endpoints
 * conversationally via tools.
 *
 * Protected endpoints:
 *   /v1/integrations/guardian/sessions
 *   /v1/integrations/guardian/sessions/resend
 *   /v1/integrations/guardian/status
 *   /v1/integrations/guardian/revoke
 */

const GUARDIAN_ENDPOINT_PATHS = [
  "/v1/integrations/guardian/sessions",
  "/v1/integrations/guardian/sessions/resend",
  "/v1/integrations/guardian/status",
  "/v1/integrations/guardian/revoke",
] as const;

/**
 * Broad regex that catches any path targeting the guardian control-plane,
 * even if the exact sub-path differs from the hardcoded list above.
 * Anchored on a path separator so it won't match inside unrelated words.
 */
const GUARDIAN_PATH_REGEX = /\/v1\/integrations\/guardian\//;

/** Tools whose `input.command` (string) may contain guardian endpoint paths. */
const COMMAND_TOOLS = new Set(["bash", "host_bash"]);

/** Tools whose `input.url` (string) may contain guardian endpoint paths. */
const URL_TOOLS = new Set(["network_request", "web_fetch", "browser_navigate"]);

/**
 * Normalize a string to defeat common URL obfuscation techniques before matching:
 * - Decode percent-encoded characters (e.g. %2F → /)
 * - Collapse consecutive slashes into a single slash (preserving protocol://)
 * - Lowercase everything
 */
function normalizeForMatching(value: string): string {
  let normalized = value;
  // Iteratively decode percent-encoding to handle double-encoding (%252F → %2F → /)
  // Use per-sequence replacement instead of decodeURIComponent to avoid a single
  // malformed sequence (e.g. %ZZ) preventing all other valid sequences from decoding.
  let prev = "";
  while (prev !== normalized) {
    prev = normalized;
    normalized = normalized.replace(/%[0-9a-fA-F]{2}/g, (match) => {
      try {
        return decodeURIComponent(match);
      } catch {
        return match;
      }
    });
  }
  // Collapse consecutive slashes (but preserve the double slash in protocol e.g. https://)
  normalized = normalized.replace(/(?<!:)\/{2,}/g, "/");
  return normalized.toLowerCase();
}

/**
 * Check whether a string contains any of the guardian control-plane endpoint paths.
 * Normalizes the input first to catch percent-encoding, double slashes, and case
 * variations. Also matches a broad regex pattern to catch paths that target the
 * guardian control-plane but aren't in the exact hardcoded list.
 */
function containsGuardianEndpointPath(value: string): boolean {
  const normalized = normalizeForMatching(value);
  // Check exact hardcoded paths against the normalized string
  for (const path of GUARDIAN_ENDPOINT_PATHS) {
    if (normalized.includes(path)) return true;
  }
  // Broad pattern match to catch any /v1/integrations/guardian/... path
  if (GUARDIAN_PATH_REGEX.test(normalized)) return true;
  return false;
}

/**
 * Conservative fallback for shell tools: detects when a command contains the
 * key fragments of a guardian control-plane path even if they are not contiguous
 * (e.g. constructed via shell variable expansion like `base=/v1/integrations; curl "$base/guardian/status"`).
 *
 * Only applied to bash/host_bash — URL tools pass structured URLs that cannot
 * be split by shell expansion.
 */
function containsGuardianFragments(command: string): boolean {
  const lower = command.toLowerCase();
  return lower.includes("/v1/integrations") && lower.includes("guardian");
}

/**
 * Pure function that determines whether a tool invocation targets a guardian
 * control-plane endpoint based on the tool name and its input.
 */
export function isGuardianControlPlaneInvocation(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (COMMAND_TOOLS.has(toolName)) {
    const command = input.command;
    if (typeof command === "string") {
      // Primary: exact/normalized path matching
      if (containsGuardianEndpointPath(command)) return true;
      // Fallback: detect shell-expanded construction of guardian paths
      if (containsGuardianFragments(command)) return true;
    }
  }

  if (URL_TOOLS.has(toolName)) {
    const url = input.url;
    if (typeof url === "string" && containsGuardianEndpointPath(url)) {
      return true;
    }
  }

  return false;
}

/**
 * Enforce the guardian-only policy: if the invocation targets a guardian
 * control-plane endpoint and the actor is not a guardian, deny.
 */
export function enforceGuardianOnlyPolicy(
  toolName: string,
  input: Record<string, unknown>,
  trustClass: string,
): { denied: boolean; reason?: string } {
  if (!isGuardianControlPlaneInvocation(toolName, input)) {
    return { denied: false };
  }

  if (trustClass === "guardian") {
    return { denied: false };
  }

  return {
    denied: true,
    reason:
      "Guardian verification control-plane actions are restricted to guardian users. This is a security restriction \u2014 please wait for the designated guardian to perform this action.",
  };
}
