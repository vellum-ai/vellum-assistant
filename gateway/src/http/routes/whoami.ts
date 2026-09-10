/**
 * GET /v1/whoami — bound platform identity for this assistant.
 *
 * Returns assistant, user, and organization ids from the gateway-local
 * identity store (live vault read with a durable last-known file). Callers
 * that previously read `vellum:platform_*` from the credential vault should
 * use this instead.
 */

import { readPlatformIdentity } from "../../platform-user-id.js";

export async function handleWhoami(): Promise<Response> {
  const { identity, unreachable } = await readPlatformIdentity();
  if (unreachable) {
    return Response.json(
      { error: "Credential store is unreachable. Retry in a moment." },
      { status: 503 },
    );
  }
  return Response.json({
    assistantId: identity.assistantId ?? null,
    userId: identity.userId ?? null,
    organizationId: identity.organizationId ?? null,
  });
}
