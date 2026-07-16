/**
 * Temporary bridge that serves this default plugin's userland route through
 * the shared runtime route table.
 *
 * Default plugins are compiled into the assistant binary rather than installed
 * into the workspace, so the `/x/plugins/<name>/routes/` filesystem dispatcher
 * (which resolves against `<workspaceDir>/plugins/...`) does not reach them.
 * Until the dispatcher learns to serve default-plugin routes directly, this
 * module adapts the `export const POST` handler in `routes/reengage.ts` into a
 * `RouteDefinition` and carries the policy + OpenAPI metadata the shared table
 * needs. When default-plugin route dispatch lands, this file and its entry in
 * `runtime/routes/index.ts` are deleted and `routes/reengage.ts` is served
 * as-is.
 */

import { ACTOR_PRINCIPALS } from "../../../runtime/auth/route-policy.js";
import {
  type RouteDefinition,
  RouteResponse,
} from "../../../runtime/routes/types.js";
import {
  POST,
  ReengageRequestSchema,
  ReengageResponseSchema,
} from "./routes/reengage.js";

/** Invoke the userland `POST` handler and translate its `Response` for the shared table. */
async function invokePost(body: Record<string, unknown> | undefined) {
  const request = new Request(
    "http://plugin.internal/x/plugins/platform-hosted/reengage",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    },
  );
  const response = await POST(request);
  return new RouteResponse(
    await response.text(),
    {
      "content-type":
        response.headers.get("content-type") ?? "application/json",
    },
    response.status,
  );
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "platform_hosted_reengage",
    endpoint: "platform-hosted/reengage",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Generate a re-engagement email in the assistant's voice",
    description:
      "Runs a background conversation turn asking the assistant to compose a short re-engagement email drawing on the user's context, then returns the parsed subject line and body for the platform to send.",
    tags: ["platform-hosted"],
    handler: (args) => invokePost(args.body),
    requestBody: ReengageRequestSchema,
    responseBody: ReengageResponseSchema,
  },
];
