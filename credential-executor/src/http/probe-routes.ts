/**
 * Stored-credential probe HTTP endpoint for the CES managed service.
 *
 * Endpoint:
 * - `POST /v1/probes/model-access`: call a provider's model-listing endpoint
 *   with a stored credential and report which models it can reach
 *
 * The RPC transport exposes the same probe as `probe_model_access`; both land
 * on `probeModelAccess`, so a managed (HTTP) and a local (socket) deployment
 * answer identically.
 *
 * Auth: `CES_SERVICE_TOKEN` bearer token, as with the credential routes.
 */

import {
  probeModelAccess,
  type SecureKeyBackend,
} from "@vellumai/credential-storage";
import { ProbeModelAccessSchema } from "@vellumai/service-contracts/credential-rpc";

import { checkServiceTokenAuth } from "./service-token-auth.js";

export interface ProbeRouteDeps {
  /** The secure key backend holding the credential to probe with. */
  backend: SecureKeyBackend;
  /** Service token for authenticating requests. */
  serviceToken: string;
}

const PROBE_PATH = "/v1/probes/model-access";

/**
 * Try to handle a probe request. Returns a Response if the request matches
 * the probe route, or null if it doesn't (letting the caller fall through
 * to other routes).
 */
export async function handleProbeRoute(
  req: Request,
  deps: ProbeRouteDeps,
): Promise<Response | null> {
  const { pathname } = new URL(req.url);
  if (pathname !== PROBE_PATH) {
    return null;
  }

  const authError = checkServiceTokenAuth(req, deps.serviceToken);
  if (authError) {
    return authError;
  }

  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = ProbeModelAccessSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: `Invalid probe request: ${parsed.error.message}` },
      { status: 400 },
    );
  }

  return Response.json(await probeModelAccess(parsed.data, deps.backend));
}
