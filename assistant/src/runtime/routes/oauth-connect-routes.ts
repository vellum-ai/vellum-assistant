/**
 * Internal routes for daemon-owned OAuth connect flows (CLI gateway transport fix).
 *
 * POST internal/oauth/connect/start   — starts the flow in the daemon, returns auth URL
 * GET  internal/oauth/connect/status/:state — polls current flow status
 */

import { z } from "zod";

import { orchestrateOAuthConnect } from "../../oauth/connect-orchestrator.js";
import {
  getOAuthConnectState,
  setOAuthConnectComplete,
  setOAuthConnectError,
  setOAuthConnectPending,
} from "../../oauth/oauth-connect-state.js";
import { getLogger } from "../../util/logger.js";
import { BadRequestError, InternalError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("oauth-connect-routes");

async function handleOAuthConnectStart({
  body,
}: {
  body?: Record<string, unknown>;
}): Promise<{ auth_url: string; state: string }> {
  const {
    service,
    clientId,
    clientSecret,
    callbackTransport,
    requestedScopes,
  } = (body ?? {}) as {
    service: string;
    clientId: string;
    clientSecret?: string;
    callbackTransport?: string;
    requestedScopes?: string[];
  };

  if (!service) throw new BadRequestError("service is required");
  if (!clientId) throw new BadRequestError("clientId is required");
  if (callbackTransport !== "loopback" && callbackTransport !== "gateway") {
    throw new BadRequestError(
      'callbackTransport must be "loopback" or "gateway"',
    );
  }

  // Capture resolvedState separately so the onDeferredComplete closure can
  // reference it without a reference-before-assignment risk (the fire-and-forget
  // tail only fires after the await resolves, by which point resolvedState is set).
  // eslint-disable-next-line prefer-const -- intentional forward-declared binding
  let resolvedState: string | undefined;

  let result: Awaited<ReturnType<typeof orchestrateOAuthConnect>>;
  try {
    result = await orchestrateOAuthConnect({
      service,
      clientId,
      clientSecret,
      callbackTransport,
      ...(requestedScopes ? { requestedScopes } : {}),
      isInteractive: false,
      onDeferredComplete: (r) => {
        if (!resolvedState) return;
        if (r.success) {
          setOAuthConnectComplete(resolvedState, r.service, r.accountInfo, r.grantedScopes);
        } else {
          setOAuthConnectError(resolvedState, r.service, r.error ?? "OAuth connect failed");
        }
      },
    });
  } catch (err) {
    throw new InternalError(err instanceof Error ? err.message : String(err));
  }

  if (!result.success) {
    throw new InternalError(result.error);
  }
  if (!result.deferred) {
    throw new InternalError("Orchestrator returned non-deferred result");
  }

  resolvedState = result.state;
  setOAuthConnectPending(result.state, service);
  log.info({ state: result.state, service }, "oauth connect flow started");
  return { auth_url: result.authorizeUrl, state: result.state };
}

function handleOAuthConnectStatus({
  pathParams,
}: {
  pathParams?: Record<string, string>;
}): {
  status: "pending" | "complete" | "error";
  service: string;
  account_info?: string;
  granted_scopes?: string[];
  error?: string;
} {
  const { state } = pathParams as { state: string };
  const flowState = getOAuthConnectState(state);

  if (flowState === null) {
    throw new NotFoundError(`No active OAuth connect flow for state "${state}"`);
  }

  if (flowState.status === "pending") return { status: "pending", service: flowState.service };
  if (flowState.status === "complete") {
    return {
      status: "complete",
      service: flowState.service,
      ...(flowState.accountInfo ? { account_info: flowState.accountInfo } : {}),
      ...(flowState.grantedScopes ? { granted_scopes: flowState.grantedScopes } : {}),
    };
  }
  return { status: "error", service: flowState.service, error: flowState.error };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "internal_oauth_connect_start",
    endpoint: "internal/oauth/connect/start",
    method: "POST",
    summary: "Start daemon-owned OAuth connect flow",
    description:
      "Starts an OAuth connect flow in the daemon and returns the authorization URL for the CLI to open in the browser.",
    tags: ["internal"],
    requestBody: z.object({
      service: z.string(),
      clientId: z.string(),
      clientSecret: z.string().optional(),
      callbackTransport: z.enum(["loopback", "gateway"]),
      requestedScopes: z.array(z.string()).optional(),
    }),
    handler: handleOAuthConnectStart,
  },
  {
    operationId: "internal_oauth_connect_status",
    endpoint: "internal/oauth/connect/status/:state",
    method: "GET",
    summary: "Poll daemon OAuth connect flow status",
    description:
      "Returns the current status of an in-flight daemon-owned OAuth connect flow (pending/complete/error).",
    tags: ["internal"],
    pathParams: [{ name: "state" }],
    additionalResponses: {
      "404": { description: "No active OAuth connect flow for the given state token" },
    },
    handler: handleOAuthConnectStatus,
  },
];
