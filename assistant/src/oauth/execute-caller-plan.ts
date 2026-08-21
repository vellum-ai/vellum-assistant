import { VellumPlatformClient } from "../platform/client.js";
import type { OAuthCallerPlan, OAuthDirectCallerPlan } from "./caller-plan.js";
import type { OAuthConnectionResponse } from "./connection.js";
import {
  OAUTH_REQUEST_TIMEOUT_MS,
  parseOAuthFetchResponse,
} from "./oauth-fetch-response.js";
import { executePlatformProxyRequest } from "./platform-proxy-request.js";

export interface ExecuteOAuthCallerPlanDeps {
  fetchFn?: typeof fetch;
  createPlatformClient?: () => Promise<VellumPlatformClient | null>;
}

/**
 * Run a caller-side OAuth plan in this process: direct provider fetch for
 * BYO connections, or the platform external-provider proxy for managed ones.
 */
export async function executeOAuthCallerPlan(
  plan: OAuthCallerPlan,
  deps: ExecuteOAuthCallerPlanDeps = {},
): Promise<OAuthConnectionResponse> {
  if (plan.mode === "direct") {
    return executeDirectPlan(plan, deps.fetchFn ?? fetch);
  }

  const createClient =
    deps.createPlatformClient ?? (() => VellumPlatformClient.create());
  const client = await createClient();
  if (!client) {
    throw new Error(
      "Not connected to Vellum platform. Run `vellum platform connect` to connect first.",
    );
  }

  return executePlatformProxyRequest(client, plan.proxyPath, plan.envelope);
}

export function shouldRetryDirectPlanOnUnauthorized(
  plan: OAuthCallerPlan,
  status: number,
): plan is OAuthDirectCallerPlan {
  return plan.mode === "direct" && status === 401 && plan.authScheme !== "none";
}

/**
 * Prepare, execute, and (for BYO 401s) refresh-and-retry once.
 */
export async function runPreparedOAuthRequest(args: {
  prepare: (forceRefresh: boolean) => Promise<OAuthCallerPlan>;
  execute?: (
    plan: OAuthCallerPlan,
  ) => Promise<OAuthConnectionResponse>;
}): Promise<{ plan: OAuthCallerPlan; response: OAuthConnectionResponse }> {
  const execute = args.execute ?? executeOAuthCallerPlan;
  let plan = await args.prepare(false);
  let response = await execute(plan);
  if (shouldRetryDirectPlanOnUnauthorized(plan, response.status)) {
    plan = await args.prepare(true);
    response = await execute(plan);
  }
  return { plan, response };
}

async function executeDirectPlan(
  plan: OAuthDirectCallerPlan,
  fetchFn: typeof fetch,
): Promise<OAuthConnectionResponse> {
  const resp = await fetchFn(plan.url, {
    method: plan.method,
    headers: plan.headers,
    body: plan.body ? JSON.stringify(plan.body) : undefined,
    signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
  });
  return parseOAuthFetchResponse(resp);
}
