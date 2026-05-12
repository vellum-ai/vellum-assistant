import { describe, test, expect } from "bun:test";

import { getIpcRoutePolicy } from "../auth/ipc-route-policy.js";

describe("ipc-route-policy: gateway-only daemon routes", () => {
  // The gateway IPC proxy default-allows operationIds with no policy entry.
  // Routes that the daemon's HTTP route policy marks as gateway-only
  // (internal.write + svc_gateway) MUST also have a matching IPC policy
  // entry — otherwise an authenticated edge JWT can reach them by setting
  // X-Vellum-Proxy-Server: ipc, bypassing the daemon HTTP router entirely.
  test.each([
    "admin_rollbackmigrations_post",
    "emit_event",
    "internal_mcp_auth_start",
    "internal_mcp_auth_status",
    "internal_mcp_reload",
    "internal_oauth_callback",
    "internal_oauth_connect_start",
    "internal_oauth_connect_status",
    "internal_twilio_connect_action",
    "internal_twilio_status",
    "internal_twilio_voice_webhook",
    "profiler_runs_get",
    "profiler_runs_by_runId_delete",
    "profiler_runs_by_runId_export_post",
    "profiler_runs_by_runId_get",
    "upgrade_broadcast",
    "workspace_commit",
  ])("%s requires internal.write and svc_gateway", (operationId) => {
    const policy = getIpcRoutePolicy(operationId);
    expect(policy).toBeDefined();
    expect(policy!.requiredScopes).toEqual(["internal.write"]);
    expect(policy!.allowedPrincipalTypes).toEqual(["svc_gateway"]);
  });

  // channels/inbound uses ingress.write rather than internal.write.
  test("channel_inbound requires ingress.write and svc_gateway", () => {
    const policy = getIpcRoutePolicy("channel_inbound");
    expect(policy).toBeDefined();
    expect(policy!.requiredScopes).toEqual(["ingress.write"]);
    expect(policy!.allowedPrincipalTypes).toEqual(["svc_gateway"]);
  });
});

describe("ipc-route-policy: inference provider connections", () => {
  // The connection CRUD routes are reachable through the gateway IPC proxy,
  // so their settings.read/settings.write scopes must be enforced there as
  // well as on the daemon HTTP path.
  test.each([
    "inference_provider_connections_get",
    "inference_provider_connections_list",
  ])("%s requires settings.read", (operationId) => {
    const policy = getIpcRoutePolicy(operationId);
    expect(policy).toBeDefined();
    expect(policy!.requiredScopes).toEqual(["settings.read"]);
  });

  test.each([
    "inference_provider_connections_create",
    "inference_provider_connections_delete",
    "inference_provider_connections_update",
  ])("%s requires settings.write", (operationId) => {
    const policy = getIpcRoutePolicy(operationId);
    expect(policy).toBeDefined();
    expect(policy!.requiredScopes).toEqual(["settings.write"]);
  });
});
