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

describe("ipc-route-policy: ATL-315 Batch 18 — new operationIds", () => {
  // Batch 18 added IPC policy entries for operationIds shipped after the
  // initial ATL-315 cutover. Without these entries, an authenticated edge
  // JWT with only `chat.read` could reach sensitive routes (config writes,
  // platform connect, schedule creation, credential mutations, sequence
  // mutations, debug bash, etc.) by setting `X-Vellum-Proxy-Server: ipc`.
  //
  // These tests pin the scope mapping so a future refactor can't silently
  // weaken it.

  // Scope assertions — every Batch 18 entry must match the daemon HTTP
  // scope its `policyKey`/method resolves to. Asserted explicitly here
  // so a future refactor can't silently widen IPC vs. HTTP.
  test.each([
    // Reads — settings.read
    ["backup_destinations_list", "settings.read"],
    ["backup_status", "settings.read"],
    ["backups_list", "settings.read"],
    ["backups_verify", "settings.read"],
    ["config_allowlist_validate", "settings.read"],
    ["config_schema_get", "settings.read"],
    ["credentials_status", "settings.read"],
    ["domain_status", "settings.read"],
    ["email_attachment_get", "settings.read"],
    ["email_attachment_list", "settings.read"],
    ["email_download", "settings.read"],
    ["email_list", "settings.read"],
    ["email_status", "settings.read"],
    ["platform_callback_routes_list", "settings.read"],
    ["platform_status", "settings.read"],
    ["sequence_get", "settings.read"],
    ["sequence_guardrails_show", "settings.read"],
    ["sequence_list", "settings.read"],
    ["sequence_stats", "settings.read"],

    // Writes — settings.write
    ["backup_destinations_add", "settings.write"],
    ["backup_destinations_remove", "settings.write"],
    ["backup_destinations_set_encrypt", "settings.write"],
    ["backup_disable", "settings.write"],
    ["backup_enable", "settings.write"],
    ["backups_create", "settings.write"],
    ["backups_restore", "settings.write"],
    ["config_set", "settings.write"],
    ["createSchedule", "settings.write"],
    ["credentials_delete", "settings.write"],
    ["credentials_set", "settings.write"],
    ["debug_bash", "settings.write"],
    ["domain_register", "settings.write"],
    ["email_register", "settings.write"],
    ["email_send", "settings.write"],
    ["email_unregister", "settings.write"],
    ["platform_callback_routes_register", "settings.write"],
    ["platform_connect", "settings.write"],
    ["platform_disconnect", "settings.write"],
    ["sequence_cancel_enrollment", "settings.write"],
    ["sequence_guardrails_set", "settings.write"],
    ["sequence_pause", "settings.write"],
    ["sequence_resume", "settings.write"],

    // Conversation CLI — daemon elevates from chat.* to settings.*
    // because `conversations/cli/clear` wipes every conversation +
    // message + vector collection. IPC mirrors that elevation.
    ["conversation_export_cli", "settings.read"],
    ["conversation_list_cli", "settings.read"],
    ["conversation_create_cli", "settings.write"],
    ["conversations_clear_cli", "settings.write"],

    // Credentials — every credential route uses policyKey: "secrets",
    // which resolves to settings.write on POST and settings.read on GET.
    ["credentials_inspect", "settings.write"],
    ["credentials_list", "settings.write"],
    ["credentials_reveal", "settings.write"],

    // STT / TTS CLI — mirror daemon HTTP scopes
    ["stt_transcribe_file", "chat.write"],
    ["tts_synthesize_cli", "chat.read"],
  ] as const)("%s requires %s", (operationId, expectedScope) => {
    const policy = getIpcRoutePolicy(operationId);
    expect(policy).toBeDefined();
    expect(policy!.requiredScopes).toEqual([expectedScope]);
  });

  // Principal restriction — `stt_transcribe_file` reads arbitrary host
  // filesystem paths. The daemon HTTP policy locks it to ["local"] for
  // that reason; the IPC entry must mirror that boundary.
  test("stt_transcribe_file is restricted to local principal", () => {
    const policy = getIpcRoutePolicy("stt_transcribe_file");
    expect(policy).toBeDefined();
    expect(policy!.allowedPrincipalTypes).toEqual(["local"]);
  });
});
