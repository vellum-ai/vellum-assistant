/**
 * Guardian control-plane policy — deterministic gate that prevents non-guardian
 * and unverified_channel actors from invoking guardian verification endpoints
 * conversationally via tools.
 *
 * Protected endpoints:
 *   /v1/integrations/guardian/challenge
 *   /v1/integrations/guardian/status
 *   /v1/integrations/guardian/outbound/start
 *   /v1/integrations/guardian/outbound/resend
 *   /v1/integrations/guardian/outbound/cancel
 */

const GUARDIAN_ENDPOINT_PATHS = [
  '/v1/integrations/guardian/challenge',
  '/v1/integrations/guardian/status',
  '/v1/integrations/guardian/outbound/start',
  '/v1/integrations/guardian/outbound/resend',
  '/v1/integrations/guardian/outbound/cancel',
] as const;

/** Tools whose `input.command` (string) may contain guardian endpoint paths. */
const COMMAND_TOOLS = new Set(['bash', 'host_bash']);

/** Tools whose `input.url` (string) may contain guardian endpoint paths. */
const URL_TOOLS = new Set(['network_request', 'web_fetch', 'browser_navigate']);

/**
 * Check whether a string contains any of the guardian control-plane endpoint paths.
 * Matches at the path level (not hostname-specific) to catch proxied/local variants.
 */
function containsGuardianEndpointPath(value: string): boolean {
  for (const path of GUARDIAN_ENDPOINT_PATHS) {
    if (value.includes(path)) return true;
  }
  return false;
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
    if (typeof command === 'string' && containsGuardianEndpointPath(command)) {
      return true;
    }
  }

  if (URL_TOOLS.has(toolName)) {
    const url = input.url;
    if (typeof url === 'string' && containsGuardianEndpointPath(url)) {
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
  actorRole: string | undefined,
): { denied: boolean; reason?: string } {
  if (!isGuardianControlPlaneInvocation(toolName, input)) {
    return { denied: false };
  }

  if (actorRole === 'non-guardian' || actorRole === 'unverified_channel') {
    return {
      denied: true,
      reason: 'Guardian verification control-plane actions are restricted to guardian users. This is a security restriction \u2014 please wait for the designated guardian to perform this action.',
    };
  }

  return { denied: false };
}
