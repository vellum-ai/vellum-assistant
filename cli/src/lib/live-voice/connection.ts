/**
 * Resolving the live-voice WebSocket URL and the credential to open it with.
 *
 * The endpoint is the **gateway's** `/v1/live-voice`, not the runtime's. That
 * distinction is the whole of the auth story: the runtime's copy demands a
 * gateway service token, which no client can mint, while the gateway's copy
 * authenticates the caller and then mints that service token itself on the way
 * upstream (`gateway/src/http/routes/live-voice-websocket.ts`).
 *
 * What the gateway wants is an actor edge JWT belonging to the *bound
 * guardian*. Live voice is a guardian-only surface, because the daemon stamps
 * each voice turn with the guardian's trust context and the proxy replaces the
 * caller's identity upstream, so the pin at the gateway is the only place a
 * non-guardian can be stopped.
 *
 * The CLI already holds exactly that credential and has since it first paired:
 * `leaseGuardianToken` POSTs `/v1/guardian/init`, which resolves the *vellum*
 * guardian principal and mints an access token subject
 * `actor:<assistantId>:<guardianPrincipalId>`, the same principal
 * `findVellumGuardian()` returns on the other side of the check. So the pin
 * passes by construction, and there is nothing new to provision here.
 */

import {
  formatAssistantLookupError,
  formatAssistantReference,
  lookupAssistantByIdentifier,
  resolveTargetAssistant,
} from "../assistant-config.js";
import {
  guardianTokenDueForRenewal,
  loadGuardianToken,
  refreshGuardianToken,
} from "../guardian-token.js";

export interface LiveVoiceConnection {
  /** `ws(s)://…/v1/live-voice` on the assistant's gateway. */
  readonly url: string;
  /** Guardian access token, sent as `Authorization: Bearer`. */
  readonly token: string;
  readonly assistantId: string;
  /** `name (id)` when they differ, else the id, for user-facing output. */
  readonly reference: string;
}

export class LiveVoiceConnectionError extends Error {}

/**
 * Resolve the target assistant, its gateway URL, and a usable guardian token.
 *
 * Refreshes the token when it is already due for renewal, so a long session
 * does not open on a credential that expires mid-conversation. A token that is
 * merely *rejected* is not refreshed here, because that would disclose the
 * long-lived refresh credential on demand, which matches how `AssistantClient`
 * gates its own reactive refresh.
 */
export async function resolveLiveVoiceConnection(
  assistantIdArg?: string,
): Promise<LiveVoiceConnection> {
  // An explicit target is looked up by id first and display name second, and
  // an ambiguous display name is an error naming the candidates, per the
  // package's assistant-targeting convention. With no target,
  // `resolveTargetAssistant` applies the usual active/sole-entry fallback.
  const entry = assistantIdArg
    ? resolveNamedAssistant(assistantIdArg)
    : resolveTargetAssistant();

  // Platform-cloud assistants authenticate with a platform session token
  // (`X-Session-Token`), and the live-voice upgrade accepts only an actor edge
  // JWT or a velay attestation, neither of which the CLI has for a cloud
  // instance. Say so plainly rather than opening a socket that 401s.
  if (entry.cloud === "vellum") {
    throw new LiveVoiceConnectionError(
      `${formatAssistantReference(entry)} is a Vellum cloud assistant. ` +
        "Voice sessions are supported for local and self-hosted assistants only.",
    );
  }

  const baseUrl = (entry.localUrl || entry.runtimeUrl).replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new LiveVoiceConnectionError(
      `Assistant '${entry.assistantId}' has an unusable gateway URL: ${baseUrl}`,
    );
  }
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = "/v1/live-voice";

  const token = await resolveGuardianAccessToken(entry.assistantId, baseUrl);
  if (!token) {
    throw new LiveVoiceConnectionError(
      `No credential for '${entry.assistantId}'. Run 'vellum wake ` +
        `${entry.assistantId}' to lease one.`,
    );
  }

  return {
    url: parsed.toString(),
    token,
    assistantId: entry.assistantId,
    reference: formatAssistantReference(entry),
  };
}

function resolveNamedAssistant(identifier: string) {
  const result = lookupAssistantByIdentifier(identifier);
  if (result.status !== "found") {
    throw new LiveVoiceConnectionError(
      formatAssistantLookupError(identifier, result),
    );
  }
  return result.entry;
}

async function resolveGuardianAccessToken(
  assistantId: string,
  gatewayUrl: string,
): Promise<string | undefined> {
  const stored = loadGuardianToken(assistantId);
  if (!stored?.accessToken) {
    return undefined;
  }
  if (!guardianTokenDueForRenewal(stored)) {
    return stored.accessToken;
  }
  const refreshed = await refreshGuardianToken(gatewayUrl, assistantId);
  // A failed refresh is not fatal on its own: the stored token may still have
  // life left (`refreshAfter` deliberately precedes expiry), so try it rather
  // than refusing to open a session that would have worked.
  return refreshed?.accessToken ?? stored.accessToken;
}
