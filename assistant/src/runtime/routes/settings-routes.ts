/**
 * HTTP route handlers for settings, identity/avatar, voice config,
 * OAuth connect, Twitter auth, home base, and workspace files.
 *
 * Migrated from IPC handlers:
 *   - handlers/config-voice.ts (voice_config_update)
 *   - handlers/avatar.ts (generate_avatar)
 *   - handlers/oauth-connect.ts (oauth_connect_start)
 *   - handlers/twitter-auth.ts (twitter_auth_start, twitter_auth_status)
 *   - handlers/home-base.ts (home_base_get)
 *   - handlers/workspace-files.ts (workspace_files_list, workspace_file_read)
 *   - handlers/config-tools.ts (tool_names_list, tool_permission_simulate, env_vars_request)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  getNestedValue,
  invalidateConfigCache,
  loadConfig,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../config/loader.js";
import { loadSkillCatalog } from "../../config/skills.js";
import { normalizeActivationKey } from "../../daemon/handlers/config-voice.js";
import { getHomeBaseAppLink } from "../../home-base/app-link-store.js";
import {
  bootstrapHomeBaseAppLink,
  resolveHomeBaseAppId,
} from "../../home-base/bootstrap.js";
import {
  getPrebuiltHomeBasePreview,
  getPrebuiltHomeBaseTaskPayload,
} from "../../home-base/prebuilt/seed.js";
import { getPublicBaseUrl } from "../../inbound/public-ingress-urls.js";
import { getApp } from "../../memory/app-store.js";
import { orchestrateOAuthConnect } from "../../oauth/connect-orchestrator.js";
import {
  getProviderProfile,
  resolveService,
} from "../../oauth/provider-profiles.js";
import {
  check,
  classifyRisk,
  generateAllowlistOptions,
  generateScopeOptions,
} from "../../permissions/checker.js";
import { getSecureKey } from "../../security/secure-keys.js";
import { parseToolManifestFile } from "../../skills/tool-manifest.js";
import { assertMetadataWritable } from "../../tools/credentials/metadata-store.js";
import {
  type ManifestOverride,
  resolveExecutionTarget,
} from "../../tools/execution-target.js";
import { getAllTools, getTool } from "../../tools/registry.js";
import { isSideEffectTool } from "../../tools/side-effects.js";
import { setAvatarTool } from "../../tools/system/avatar-generator.js";
import { ConfigError } from "../../util/errors.js";
import { pathExists } from "../../util/fs.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import { resolveWorkspacePath } from "./workspace-utils.js";

const log = getLogger("settings-routes");

// ---------------------------------------------------------------------------
// Voice config
// ---------------------------------------------------------------------------

function handleVoiceConfigUpdate(activationKey: string): Response {
  const result = normalizeActivationKey(activationKey);
  if (!result.ok) {
    return httpError("BAD_REQUEST", result.reason, 400);
  }
  // The broadcast to IPC clients happens via the IPC handler. The HTTP
  // route validates and returns the canonical value; the caller (client)
  // applies the setting locally.
  return Response.json({ ok: true, activationKey: result.value });
}

// ---------------------------------------------------------------------------
// Avatar generation
// ---------------------------------------------------------------------------

async function handleGenerateAvatar(description: string): Promise<Response> {
  if (!description.trim()) {
    return httpError("BAD_REQUEST", "Description is required.", 400);
  }

  log.info({ description }, "Generating avatar via HTTP request");

  try {
    const result = await setAvatarTool.execute(
      { description },
      // Minimal tool context -- avatar generation needs no session context
      {} as Parameters<typeof setAvatarTool.execute>[1],
    );

    if (result.isError) {
      return httpError("INTERNAL_ERROR", result.content, 500);
    }

    const avatarPath = join(
      getWorkspaceDir(),
      "data",
      "avatar",
      "custom-avatar.png",
    );
    return Response.json({ ok: true, avatarPath });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ error: message }, "Avatar generation failed unexpectedly");
    return httpError("INTERNAL_ERROR", message, 500);
  }
}

// ---------------------------------------------------------------------------
// Client settings update (generic)
// ---------------------------------------------------------------------------

function handleClientSettingsUpdate(key: string, value: string): Response {
  // The HTTP route accepts key/value pairs for client settings.
  // Validation is key-specific.
  if (key === "activationKey") {
    return handleVoiceConfigUpdate(value);
  }
  // For other keys, accept as-is
  return Response.json({ ok: true, key, value });
}

// ---------------------------------------------------------------------------
// OAuth connect
// ---------------------------------------------------------------------------

/** Map raw orchestrator/provider error messages to user-friendly strings. */
function sanitizeOAuthError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("timed out")) {
    return "OAuth authentication timed out. Please try again.";
  }
  if (lower.includes("user_cancelled") || lower.includes("cancelled")) {
    return "OAuth authentication was cancelled.";
  }
  if (lower.includes("denied") || lower.includes("invalid_grant")) {
    return "The authorization request was denied. Please try again.";
  }
  return "OAuth authentication failed. Please try again.";
}

/** Resolve client_secret from the keychain, checking canonical then alias service name. */
function getClientSecret(
  resolvedService: string,
  rawService: string,
): string | undefined {
  return (
    getSecureKey(`credential:${resolvedService}:client_secret`) ??
    (resolvedService !== rawService
      ? getSecureKey(`credential:${rawService}:client_secret`)
      : undefined) ??
    undefined
  );
}

async function handleOAuthConnectStart(body: {
  service?: string;
  requestedScopes?: string[];
}): Promise<Response> {
  try {
    assertMetadataWritable();
  } catch {
    return httpError(
      "UNPROCESSABLE_ENTITY",
      "Credential metadata file has an unrecognized version. Cannot store OAuth credentials.",
      422,
    );
  }

  if (!body.service) {
    return httpError("BAD_REQUEST", "Missing required field: service", 400);
  }

  const resolvedService = resolveService(body.service);

  let clientId = getSecureKey(`credential:${resolvedService}:client_id`);
  if (!clientId && resolvedService !== body.service) {
    clientId = getSecureKey(`credential:${body.service}:client_id`);
  }

  if (!clientId) {
    return httpError(
      "BAD_REQUEST",
      `No client_id found for "${body.service}". Store it first via the credential vault.`,
      400,
    );
  }

  const clientSecret = getClientSecret(resolvedService, body.service);

  const profile = getProviderProfile(resolvedService);
  const requiresSecret =
    profile?.setup?.requiresClientSecret ??
    !!(profile?.tokenEndpointAuthMethod || profile?.extraParams);
  if (requiresSecret && !clientSecret) {
    return httpError(
      "BAD_REQUEST",
      `client_secret is required for "${body.service}" but not found in the keychain. Store it first via the credential vault.`,
      400,
    );
  }

  try {
    // For HTTP, we cannot send `open_url` mid-request. The auth URL is
    // returned to the client to open.
    let authUrl: string | undefined;

    const result = await orchestrateOAuthConnect({
      service: body.service,
      requestedScopes: body.requestedScopes,
      clientId,
      clientSecret,
      isInteractive: true,
      openUrl: (url: string) => {
        authUrl = url;
      },
    });

    if (!result.success) {
      log.error(
        { err: result.error, service: body.service },
        "OAuth connect orchestrator returned error",
      );
      return httpError(
        "INTERNAL_ERROR",
        result.safeError ? result.error : sanitizeOAuthError(result.error),
        500,
      );
    }

    if (result.deferred) {
      return Response.json({
        ok: true,
        deferred: true,
        authUrl: result.authUrl,
      });
    }

    return Response.json({
      ok: true,
      grantedScopes: result.grantedScopes,
      accountInfo: result.accountInfo,
      ...(authUrl ? { authUrl } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, service: body.service }, "OAuth connect flow failed");
    return httpError("INTERNAL_ERROR", sanitizeOAuthError(message), 500);
  }
}

// ---------------------------------------------------------------------------
// Twitter auth
// ---------------------------------------------------------------------------

function sanitizeTwitterAuthError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("timed out")) {
    return "Twitter authentication timed out. Please try again.";
  }
  if (lower.includes("user_cancelled") || lower.includes("cancelled")) {
    return "Twitter authentication was cancelled.";
  }
  if (lower.includes("denied") || lower.includes("invalid_grant")) {
    return "Twitter denied the authorization request. Please try again.";
  }
  return "Twitter authentication failed. Please try again.";
}

async function handleTwitterAuthStart(): Promise<Response> {
  try {
    assertMetadataWritable();
  } catch {
    return httpError(
      "UNPROCESSABLE_ENTITY",
      "Credential metadata file has an unrecognized version. Cannot store OAuth credentials.",
      422,
    );
  }

  try {
    const raw = loadRawConfig();
    const mode =
      (getNestedValue(raw, "twitter.integrationMode") as string | undefined) ??
      "local_byo";
    if (mode !== "local_byo") {
      return httpError(
        "BAD_REQUEST",
        'Twitter integration mode must be "local_byo" to use this flow.',
        400,
      );
    }

    const clientId = getSecureKey("credential:integration:twitter:client_id");
    if (!clientId) {
      return httpError(
        "BAD_REQUEST",
        "No Twitter client credentials configured. Please set up your Client ID first.",
        400,
      );
    }

    const clientSecret =
      getSecureKey("credential:integration:twitter:client_secret") || undefined;

    let config;
    try {
      config = loadConfig();
    } catch (err) {
      const detail = err instanceof ConfigError ? err.message : String(err);
      return httpError(
        "INTERNAL_ERROR",
        `Unable to load config: ${detail}`,
        500,
      );
    }

    try {
      getPublicBaseUrl(config);
    } catch {
      return httpError(
        "BAD_REQUEST",
        "Set ingress.publicBaseUrl (or INGRESS_PUBLIC_BASE_URL) so OAuth callbacks can route through /webhooks/oauth/callback on the gateway.",
        400,
      );
    }

    let authUrl: string | undefined;

    const result = await orchestrateOAuthConnect({
      service: "integration:twitter",
      clientId,
      clientSecret,
      isInteractive: true,
      openUrl: (url: string) => {
        authUrl = url;
      },
      allowedTools: ["twitter_post"],
    });

    if (!result.success) {
      log.error(
        { err: result.error },
        "Twitter OAuth orchestrator returned error",
      );
      return httpError(
        "INTERNAL_ERROR",
        result.safeError
          ? result.error
          : sanitizeTwitterAuthError(result.error),
        500,
      );
    }

    if (result.deferred) {
      return Response.json({
        ok: true,
        deferred: true,
        authUrl: result.authUrl,
      });
    }

    // Persist accountInfo to config
    if (result.accountInfo) {
      try {
        const raw2 = loadRawConfig();
        setNestedValue(raw2, "twitter.accountInfo", result.accountInfo);
        saveRawConfig(raw2);
        invalidateConfigCache();
      } catch {
        // Non-fatal
      }
    }

    return Response.json({
      ok: true,
      accountInfo: result.accountInfo,
      ...(authUrl ? { authUrl } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Twitter OAuth flow failed");
    return httpError(
      "INTERNAL_ERROR",
      sanitizeTwitterAuthError(message),
      500,
    );
  }
}

function handleTwitterAuthStatus(): Response {
  try {
    const accessToken = getSecureKey(
      "credential:integration:twitter:access_token",
    );
    const raw = loadRawConfig();
    const mode =
      (getNestedValue(raw, "twitter.integrationMode") as
        | "local_byo"
        | "managed"
        | undefined) ?? "local_byo";
    const accountInfo = getNestedValue(raw, "twitter.accountInfo") as
      | string
      | undefined;

    return Response.json({
      connected: !!accessToken,
      accountInfo: accountInfo ?? undefined,
      mode,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to get Twitter auth status");
    return httpError("INTERNAL_ERROR", message, 500);
  }
}

// ---------------------------------------------------------------------------
// Home base
// ---------------------------------------------------------------------------

function handleHomeBaseGet(ensureLinked: boolean): Response {
  try {
    if (ensureLinked !== false) {
      bootstrapHomeBaseAppLink();
    }

    const appId = resolveHomeBaseAppId();
    if (!appId) {
      return Response.json({ homeBase: null });
    }

    const link = getHomeBaseAppLink();
    const source = link?.source ?? "prebuilt_seed";

    let preview: {
      title: string;
      subtitle: string;
      description: string;
      icon: string;
      metrics: Array<{ label: string; value: string }>;
    };

    if (source === "personalized") {
      const app = getApp(appId);
      if (app) {
        preview = {
          title: app.name,
          subtitle: "Dashboard",
          description: app.description ?? "",
          icon: app.icon ?? "",
          metrics: [],
        };
      } else {
        preview = getPrebuiltHomeBasePreview();
      }
    } else {
      preview = getPrebuiltHomeBasePreview();
    }

    const tasks = getPrebuiltHomeBaseTaskPayload();

    return Response.json({
      homeBase: {
        appId,
        source,
        starterTasks: tasks.starterTasks,
        onboardingTasks: tasks.onboardingTasks,
        preview,
      },
    });
  } catch (err) {
    log.error({ err }, "Failed to resolve home base metadata");
    return Response.json({ homeBase: null });
  }
}

// ---------------------------------------------------------------------------
// Workspace files (IPC-style list/read)
// ---------------------------------------------------------------------------

const WORKSPACE_FILES = ["IDENTITY.md", "SOUL.md", "USER.md", "skills/"];

function handleWorkspaceFilesList(): Response {
  const base = getWorkspaceDir();
  const files = WORKSPACE_FILES.map((name) => ({
    path: name,
    name,
    exists: pathExists(join(base, name)),
  }));
  return Response.json({ files });
}

function handleWorkspaceFileRead(requestedPath: string): Response {
  const resolved = resolveWorkspacePath(requestedPath);
  if (resolved === undefined) {
    return httpError("BAD_REQUEST", "Invalid path", 400);
  }

  try {
    if (!pathExists(resolved)) {
      return httpError("NOT_FOUND", "File not found", 404);
    }
    const content = readFileSync(resolved, "utf-8");
    return Response.json({ path: requestedPath, content });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, path: requestedPath }, "Failed to read workspace file");
    return httpError("INTERNAL_ERROR", message, 500);
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Look up manifest metadata for a tool that isn't in the live registry.
 */
function resolveManifestOverride(
  toolName: string,
): ManifestOverride | undefined {
  if (getTool(toolName)) return undefined;
  try {
    const catalog = loadSkillCatalog();
    for (const skill of catalog) {
      if (!skill.toolManifest?.present || !skill.toolManifest.valid) continue;
      try {
        const manifest = parseToolManifestFile(
          join(skill.directoryPath, "TOOLS.json"),
        );
        const entry = manifest.tools.find((t) => t.name === toolName);
        if (entry) {
          return { risk: entry.risk, execution_target: entry.execution_target };
        }
      } catch {
        // Skip unparseable manifests
      }
    }
  } catch {
    // Non-fatal
  }
  return undefined;
}

function handleToolNamesList(): Response {
  const tools = getAllTools();
  const nameSet = new Set(tools.map((t) => t.name));
  const schemas: Record<
    string,
    {
      type: string;
      properties?: Record<string, unknown>;
      required?: string[];
    }
  > = {};
  for (const tool of tools) {
    try {
      const def = tool.getDefinition();
      schemas[tool.name] = def.input_schema as (typeof schemas)[string];
    } catch {
      // Skip tools whose definitions can't be resolved
    }
  }

  try {
    const catalog = loadSkillCatalog();
    for (const skill of catalog) {
      if (!skill.toolManifest?.present || !skill.toolManifest.valid) continue;
      try {
        const manifest = parseToolManifestFile(
          join(skill.directoryPath, "TOOLS.json"),
        );
        for (const entry of manifest.tools) {
          if (nameSet.has(entry.name)) continue;
          nameSet.add(entry.name);
          schemas[entry.name] = entry.input_schema as unknown as (typeof schemas)[string];
        }
      } catch {
        // Skip skills whose manifests can't be parsed
      }
    }
  } catch {
    // Non-fatal
  }

  const names = Array.from(nameSet).sort((a, b) => a.localeCompare(b));
  return Response.json({ names, schemas });
}

async function handleToolPermissionSimulate(body: {
  toolName?: string;
  input?: Record<string, unknown>;
  workingDir?: string;
  forcePromptSideEffects?: boolean;
  isInteractive?: boolean;
}): Promise<Response> {
  if (!body.toolName || typeof body.toolName !== "string") {
    return httpError("BAD_REQUEST", "toolName is required", 400);
  }
  if (!body.input || typeof body.input !== "object") {
    return httpError(
      "BAD_REQUEST",
      "input is required and must be an object",
      400,
    );
  }

  const workingDir = body.workingDir ?? process.cwd();

  try {
    const manifestOverride = resolveManifestOverride(body.toolName);
    const executionTarget = resolveExecutionTarget(
      body.toolName,
      manifestOverride,
    );
    const policyContext = { executionTarget };

    const riskLevel = await classifyRisk(
      body.toolName,
      body.input,
      workingDir,
      undefined,
      manifestOverride,
    );
    const result = await check(
      body.toolName,
      body.input,
      workingDir,
      policyContext,
      manifestOverride,
    );

    // Private-thread override
    if (
      body.forcePromptSideEffects &&
      result.decision === "allow" &&
      isSideEffectTool(body.toolName, body.input)
    ) {
      result.decision = "prompt";
      result.reason =
        "Private thread: side-effect tools require explicit approval";
    }

    // Non-interactive override
    if (body.isInteractive === false && result.decision === "prompt") {
      result.decision = "deny";
      result.reason = "Non-interactive session: no client to approve prompt";
    }

    let promptPayload:
      | {
          allowlistOptions: Array<{
            label: string;
            description: string;
            pattern: string;
          }>;
          scopeOptions: Array<{ label: string; scope: string }>;
          persistentDecisionsAllowed: boolean;
        }
      | undefined;

    if (result.decision === "prompt") {
      const allowlistOptions = await generateAllowlistOptions(
        body.toolName,
        body.input,
      );
      const scopeOptions = generateScopeOptions(workingDir, body.toolName);
      promptPayload = {
        allowlistOptions,
        scopeOptions,
        persistentDecisionsAllowed: true,
      };
    }

    return Response.json({
      ok: true,
      decision: result.decision,
      riskLevel,
      reason: result.reason,
      executionTarget,
      matchedRuleId: result.matchedRule?.id,
      promptPayload,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to simulate tool permission");
    return httpError("INTERNAL_ERROR", message, 500);
  }
}

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------

function handleEnvVars(): Response {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) vars[key] = value;
  }
  return Response.json({ vars });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function settingsRouteDefinitions(): RouteDefinition[] {
  return [
    // Voice config
    {
      endpoint: "settings/voice",
      method: "PUT",
      policyKey: "settings/voice",
      handler: async ({ req }) => {
        const body = (await req.json()) as { activationKey?: string };
        if (!body.activationKey) {
          return httpError(
            "BAD_REQUEST",
            "activationKey is required",
            400,
          );
        }
        return handleVoiceConfigUpdate(body.activationKey);
      },
    },

    // Avatar generation
    {
      endpoint: "settings/avatar/generate",
      method: "POST",
      policyKey: "settings/avatar/generate",
      handler: async ({ req }) => {
        const body = (await req.json()) as { description?: string };
        return handleGenerateAvatar(body.description ?? "");
      },
    },

    // Client settings update
    {
      endpoint: "settings/client",
      method: "PUT",
      policyKey: "settings/client",
      handler: async ({ req }) => {
        const body = (await req.json()) as { key?: string; value?: string };
        if (!body.key || body.value === undefined) {
          return httpError(
            "BAD_REQUEST",
            "key and value are required",
            400,
          );
        }
        return handleClientSettingsUpdate(body.key, body.value);
      },
    },

    // OAuth connect
    {
      endpoint: "integrations/oauth/start",
      method: "POST",
      policyKey: "integrations/oauth/start",
      handler: async ({ req }) => {
        const body = (await req.json()) as {
          service?: string;
          requestedScopes?: string[];
        };
        return handleOAuthConnectStart(body);
      },
    },

    // Twitter auth
    {
      endpoint: "integrations/twitter/auth/start",
      method: "POST",
      policyKey: "integrations/twitter/auth/start",
      handler: async () => handleTwitterAuthStart(),
    },
    {
      endpoint: "integrations/twitter/auth/status",
      method: "GET",
      policyKey: "integrations/twitter/auth/status",
      handler: () => handleTwitterAuthStatus(),
    },

    // Home base
    {
      endpoint: "home-base",
      method: "GET",
      policyKey: "home-base",
      handler: ({ url }) => {
        const ensureLinked = url.searchParams.get("ensureLinked") !== "false";
        return handleHomeBaseGet(ensureLinked);
      },
    },

    // Workspace files (IPC-style list/read -- distinct from workspace-routes.ts tree/file)
    {
      endpoint: "workspace-files",
      method: "GET",
      policyKey: "workspace-files",
      handler: () => handleWorkspaceFilesList(),
    },
    {
      endpoint: "workspace-files/read",
      method: "GET",
      policyKey: "workspace-files/read",
      handler: ({ url }) => {
        const filePath = url.searchParams.get("path") ?? "";
        if (!filePath) {
          return httpError("BAD_REQUEST", "path query parameter is required", 400);
        }
        return handleWorkspaceFileRead(filePath);
      },
    },

    // Tool names list
    {
      endpoint: "tools",
      method: "GET",
      policyKey: "tools",
      handler: () => handleToolNamesList(),
    },

    // Tool permission simulate
    {
      endpoint: "tools/simulate-permission",
      method: "POST",
      policyKey: "tools/simulate-permission",
      handler: async ({ req }) => {
        const body = (await req.json()) as {
          toolName?: string;
          input?: Record<string, unknown>;
          workingDir?: string;
          forcePromptSideEffects?: boolean;
          isInteractive?: boolean;
        };
        return handleToolPermissionSimulate(body);
      },
    },

    // Environment variables
    {
      endpoint: "diagnostics/env-vars",
      method: "GET",
      policyKey: "diagnostics/env-vars",
      handler: () => handleEnvVars(),
    },
  ];
}
