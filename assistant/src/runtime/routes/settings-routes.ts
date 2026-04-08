/**
 * HTTP route handlers for settings, identity/avatar, voice config,
 * OAuth connect, and workspace files.
 *
 * Handles settings, identity/avatar, voice config,
 * OAuth connect, and workspace files.
 *   - handlers/config-tools.ts (tool_names_list, tool_permission_simulate, env_vars_request)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import {
  getPlatformBaseUrl,
  setIngressPublicBaseUrl,
} from "../../config/env.js";
import { loadRawConfig, saveRawConfig } from "../../config/loader.js";
import { loadSkillCatalog } from "../../config/skills.js";
import {
  computeGatewayTarget,
  getIngressConfigResult,
} from "../../daemon/handlers/config-ingress.js";
import { normalizeActivationKey } from "../../daemon/handlers/config-voice.js";
import { orchestrateOAuthConnect } from "../../oauth/connect-orchestrator.js";
import {
  getApp,
  getConnectionByProvider,
  getMostRecentAppByProvider,
  getProvider,
} from "../../oauth/oauth-store.js";
import {
  check,
  classifyRisk,
  generateAllowlistOptions,
  generateScopeOptions,
} from "../../permissions/checker.js";
import { getSecureKeyAsync } from "../../security/secure-keys.js";
import { parseToolManifestFile } from "../../skills/tool-manifest.js";
import {
  type ManifestOverride,
  resolveExecutionTarget,
} from "../../tools/execution-target.js";
import { getAllTools, getTool } from "../../tools/registry.js";
import {
  ACTIVITY_SKIP_SET,
  injectActivityField,
} from "../../tools/schema-transforms.js";
import { isSideEffectTool } from "../../tools/side-effects.js";
import { generateAndSaveAvatar } from "../../tools/system/avatar-generator.js";
import { pathExists } from "../../util/fs.js";
import { getLogger } from "../../util/logger.js";
import { getAvatarImagePath, getWorkspaceDir } from "../../util/platform.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
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
  // The HTTP route validates and returns the canonical value; the caller
  // (client) applies the setting locally.
  return Response.json({ ok: true, activationKey: result.value });
}

// ---------------------------------------------------------------------------
// Avatar generation
// ---------------------------------------------------------------------------

// Also callable via the `vellum-avatar` skill's AI generation mode.
async function handleGenerateAvatar(description: string): Promise<Response> {
  if (!description.trim()) {
    return httpError("BAD_REQUEST", "Description is required.", 400);
  }

  log.info({ description }, "Generating avatar via HTTP request");

  try {
    const result = await generateAndSaveAvatar(description);

    if (result.isError) {
      return httpError("INTERNAL_ERROR", result.content, 500);
    }

    const avatarPath = getAvatarImagePath();

    // Notify all connected SSE clients so every macOS/iOS instance
    // reloads the avatar image immediately.
    assistantEventHub
      .publish(
        buildAssistantEvent(DAEMON_INTERNAL_ASSISTANT_ID, {
          type: "avatar_updated",
          avatarPath,
        }),
      )
      .catch((err) => {
        log.warn({ err }, "Failed to publish avatar_updated event");
      });

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

const SUPPORTED_CLIENT_SETTINGS_KEYS = new Set(["activationKey"]);

function handleClientSettingsUpdate(key: string, value: string): Response {
  if (key === "activationKey") {
    return handleVoiceConfigUpdate(value);
  }
  return httpError(
    "BAD_REQUEST",
    `Unsupported client setting key: "${key}". Supported keys: ${[...SUPPORTED_CLIENT_SETTINGS_KEYS].join(", ")}`,
    400,
  );
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

async function handleOAuthConnectStart(body: {
  service?: string;
  requestedScopes?: string[];
}): Promise<Response> {
  if (!body.service) {
    return httpError("BAD_REQUEST", "Missing required field: service", 400);
  }

  const service = body.service;

  // Resolve client_id and client_secret from oauth-store.
  let clientId: string | undefined;
  let clientSecret: string | undefined;

  // Try existing connection first (re-auth flow)
  const conn = getConnectionByProvider(service);
  if (conn) {
    const app = getApp(conn.oauthAppId);
    if (app) {
      clientId = app.clientId;
      clientSecret = await getSecureKeyAsync(app.clientSecretCredentialPath);
    }
  }

  // Fall back to most recent app for this provider (first-time connect with stored app)
  if (!clientId) {
    const dbApp = getMostRecentAppByProvider(service);
    if (dbApp) {
      clientId = dbApp.clientId;
      if (!clientSecret) {
        clientSecret = await getSecureKeyAsync(
          dbApp.clientSecretCredentialPath,
        );
      }
    }
  }

  if (!clientId) {
    return httpError(
      "BAD_REQUEST",
      `No client_id found for "${service}". Store it first via the credential vault.`,
      400,
    );
  }

  const providerRow = getProvider(service);
  const requiresSecret = !!providerRow?.requiresClientSecret;
  if (requiresSecret && !clientSecret) {
    return httpError(
      "BAD_REQUEST",
      `client_secret is required for "${service}" but not found in the credential store. Store it first via the credential vault.`,
      400,
    );
  }

  try {
    // For HTTP, we cannot send `open_url` mid-request. The auth URL is
    // returned to the client to open.
    let authorizeUrl: string | undefined;

    const result = await orchestrateOAuthConnect({
      service,
      requestedScopes: body.requestedScopes,
      clientId,
      clientSecret,
      callbackTransport: "loopback",
      isInteractive: true,
      openUrl: (url: string) => {
        authorizeUrl = url;
      },
      onDeferredComplete: (deferredResult) => {
        // Prefer accountInfo from oauth-store when available.
        let accountInfo = deferredResult.accountInfo;
        try {
          const conn = getConnectionByProvider(service);
          if (conn?.accountInfo) accountInfo = conn.accountInfo;
        } catch {
          // DB not ready — use orchestrator value
        }

        // Emit oauth_connect_result to all connected SSE clients so the
        // UI can update immediately when the deferred browser flow completes.
        assistantEventHub
          .publish(
            buildAssistantEvent(DAEMON_INTERNAL_ASSISTANT_ID, {
              type: "oauth_connect_result",
              success: deferredResult.success,
              service: deferredResult.service,
              accountInfo,
              error: deferredResult.error,
            }),
          )
          .catch((err) => {
            log.warn(
              { err, service: deferredResult.service },
              "Failed to publish oauth_connect_result event",
            );
          });

        if (!deferredResult.success) {
          log.warn(
            {
              service: deferredResult.service,
              err: deferredResult.error,
            },
            "Deferred OAuth connect failed",
          );
        }
      },
    });

    if (!result.success) {
      log.error(
        { err: result.error, service },
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
        // Wire key stays `authUrl` for backward compatibility with existing
        // clients; the internal field on `result` is `authorizeUrl`.
        authUrl: result.authorizeUrl,
      });
    }

    // Prefer accountInfo from oauth-store when available.
    let responseAccountInfo = result.accountInfo;
    try {
      const conn = getConnectionByProvider(service);
      if (conn?.accountInfo) responseAccountInfo = conn.accountInfo;
    } catch {
      // DB not ready — use orchestrator value
    }

    return Response.json({
      ok: true,
      grantedScopes: result.grantedScopes,
      accountInfo: responseAccountInfo,
      // Wire key stays `authUrl` for backward compatibility with existing
      // clients; the local variable was renamed to `authorizeUrl`.
      ...(authorizeUrl ? { authUrl: authorizeUrl } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, service }, "OAuth connect flow failed");
    return httpError("INTERNAL_ERROR", sanitizeOAuthError(message), 500);
  }
}

// ---------------------------------------------------------------------------
// Workspace files (list/read)
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
  type SchemaShape = {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const schemas: Record<string, SchemaShape> = {};

  // Collect raw definitions from the registry so we can transform them.
  const rawDefs: import("../../providers/types.js").ToolDefinition[] = [];
  for (const tool of tools) {
    try {
      rawDefs.push(tool.getDefinition());
    } catch {
      // Skip tools whose definitions can't be resolved
    }
  }

  // Apply activity injection so settings/debug schemas match runtime behavior.
  const transformedDefs = injectActivityField(rawDefs, ACTIVITY_SKIP_SET);
  for (const def of transformedDefs) {
    schemas[def.name] = def.input_schema as SchemaShape;
  }

  // Skill manifest schemas are served raw (untransformed). Unlike runtime tool
  // schemas which have `activity` injected via injectActivityField(), skill
  // manifests reflect the original TOOLS.json content. This is intentional:
  // skill tools are invoked through skill_execute (which has its own activity
  // field), so their individual schemas are never sent to the LLM directly.
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
          schemas[entry.name] = entry.input_schema as unknown as SchemaShape;
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

    // Private-conversation override
    if (
      body.forcePromptSideEffects &&
      result.decision === "allow" &&
      isSideEffectTool(body.toolName, body.input)
    ) {
      result.decision = "prompt";
      result.reason =
        "Private conversation: side-effect tools require explicit approval";
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
      success: true,
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

/**
 * Allowlist of env-var names safe to expose via diagnostics.
 * Everything else is redacted to prevent secret leakage.
 *
 * IMPORTANT: Exact names use strict `===` matching so that e.g. "HOME" does
 * not also expose "HOME_SECRET". Only entries in the *prefixes* list (which
 * all end with `_`) use `startsWith`.
 */
const SAFE_ENV_VAR_EXACT_NAMES = new Set([
  "LANG",
  "TERM",
  "SHELL",
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "PWD",
  "OLDPWD",
  "HOSTNAME",
  "DISPLAY",
  "COLORTERM",
  "EDITOR",
  "VISUAL",
  "TZ",
  "TMPDIR",
  "QDRANT_HTTP_PORT",
  "PORT",
  "DEBUG",
]);

const SAFE_ENV_VAR_PREFIXES = [
  "NODE_",
  "BUN_",
  "npm_",
  "LC_",
  "XDG_",
  "VELLUM_",
];

function isEnvVarSafe(key: string): boolean {
  return (
    SAFE_ENV_VAR_EXACT_NAMES.has(key) ||
    SAFE_ENV_VAR_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

function handleEnvVars(): Response {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && isEnvVarSafe(key)) {
      vars[key] = value;
    }
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
      summary: "Update voice activation key",
      description: "Validate and normalize a voice activation key.",
      tags: ["settings"],
      requestBody: z.object({
        activationKey: z.string(),
      }),
      handler: async ({ req }) => {
        const body = (await req.json()) as { activationKey?: string };
        if (!body.activationKey) {
          return httpError("BAD_REQUEST", "activationKey is required", 400);
        }
        return handleVoiceConfigUpdate(body.activationKey);
      },
    },

    // Avatar generation
    {
      endpoint: "settings/avatar/generate",
      method: "POST",
      policyKey: "settings/avatar/generate",
      summary: "Generate avatar",
      description: "Generate an AI avatar image from a text description.",
      tags: ["settings"],
      requestBody: z.object({
        description: z.string(),
      }),
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
      summary: "Update client setting",
      description: "Set a single client-side setting key/value pair.",
      tags: ["settings"],
      requestBody: z.object({
        key: z.string(),
        value: z.string(),
      }),
      handler: async ({ req }) => {
        const body = (await req.json()) as { key?: string; value?: string };
        if (!body.key || body.value === undefined) {
          return httpError("BAD_REQUEST", "key and value are required", 400);
        }
        return handleClientSettingsUpdate(body.key, body.value);
      },
    },

    // OAuth connect
    {
      endpoint: "oauth/start",
      method: "POST",
      policyKey: "oauth/start",
      summary: "Start OAuth flow",
      description:
        "Initiate an OAuth authorization flow for a third-party service.",
      tags: ["oauth"],
      requestBody: z.object({
        service: z.string(),
        requestedScopes: z.array(z.unknown()),
      }),
      handler: async ({ req }) => {
        const body = (await req.json()) as {
          service?: string;
          requestedScopes?: string[];
        };
        return handleOAuthConnectStart(body);
      },
    },
    // Legacy alias for oauth/start (kept for backwards compatibility with
    // older clients and platform proxy routes)
    {
      endpoint: "integrations/oauth/start",
      method: "POST",
      policyKey: "integrations/oauth/start",
      summary: "Start OAuth flow (legacy)",
      description: "Legacy alias for oauth/start.",
      tags: ["oauth"],
      requestBody: z.object({
        service: z.string(),
        requestedScopes: z.array(z.unknown()),
      }),
      handler: async ({ req }) => {
        const body = (await req.json()) as {
          service?: string;
          requestedScopes?: string[];
        };
        return handleOAuthConnectStart(body);
      },
    },

    // Workspace files (list/read -- distinct from workspace-routes.ts tree/file)
    {
      endpoint: "workspace-files",
      method: "GET",
      policyKey: "workspace-files",
      summary: "List workspace files",
      description: "Return an array of files in the workspace directory.",
      tags: ["workspace"],
      handler: () => handleWorkspaceFilesList(),
    },
    {
      endpoint: "workspace-files/read",
      method: "GET",
      policyKey: "workspace-files/read",
      summary: "Read a workspace file",
      description: "Return the contents of a single file by path.",
      tags: ["workspace"],
      handler: ({ url }) => {
        const filePath = url.searchParams.get("path") ?? "";
        if (!filePath) {
          return httpError(
            "BAD_REQUEST",
            "path query parameter is required",
            400,
          );
        }
        return handleWorkspaceFileRead(filePath);
      },
    },

    // Tool names list
    {
      endpoint: "tools",
      method: "GET",
      policyKey: "tools",
      summary: "List tools",
      description:
        "Return available tool names with their descriptions, risk levels, and categories.",
      tags: ["tools"],
      handler: () => handleToolNamesList(),
    },

    // Tool permission simulate
    {
      endpoint: "tools/simulate-permission",
      method: "POST",
      policyKey: "tools/simulate-permission",
      summary: "Simulate tool permission check",
      description:
        "Dry-run a permission check for a tool invocation without executing it.",
      tags: ["tools"],
      requestBody: z.object({
        toolName: z.string(),
        input: z.object({}).passthrough(),
        workingDir: z.string(),
        forcePromptSideEffects: z.boolean(),
        isInteractive: z.boolean(),
      }),
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
      summary: "List safe environment variables",
      description:
        "Return environment variable names and values that are safe to expose (no secrets).",
      tags: ["diagnostics"],
      handler: () => handleEnvVars(),
    },

    // Platform config (GET / PUT)
    {
      endpoint: "config/platform",
      method: "GET",
      policyKey: "config/platform:GET",
      summary: "Get platform config",
      description: "Return the platform base URL configuration.",
      tags: ["config"],
      responseBody: z.object({
        baseUrl: z.string(),
        success: z.boolean(),
      }),
      handler: () => {
        const raw = loadRawConfig();
        const platform = (raw?.platform ?? {}) as Record<string, unknown>;
        const baseUrl =
          (platform.baseUrl as string | undefined) || getPlatformBaseUrl();
        return Response.json({ baseUrl, success: true });
      },
    },
    {
      endpoint: "config/platform",
      method: "PUT",
      policyKey: "config/platform",
      summary: "Update platform config",
      description: "Set the platform base URL.",
      tags: ["config"],
      requestBody: z.object({
        baseUrl: z.string(),
      }),
      handler: async ({ req }) => {
        try {
          const body = (await req.json()) as { baseUrl?: string };
          const value = (body.baseUrl ?? "").trim().replace(/\/+$/, "");
          const raw = loadRawConfig();
          const platform = (raw?.platform ?? {}) as Record<string, unknown>;
          platform.baseUrl = value || undefined;
          saveRawConfig({ ...raw, platform });
          return Response.json({ baseUrl: value, success: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ err }, "Failed to update platform config via HTTP");
          return Response.json(
            { baseUrl: "", success: false, error: message },
            { status: 500 },
          );
        }
      },
    },

    // Ingress config (GET / PUT)
    {
      endpoint: "integrations/ingress/config",
      method: "GET",
      policyKey: "integrations/ingress/config:GET",
      summary: "Get ingress config",
      description: "Return the current ingress tunnel configuration.",
      tags: ["config"],
      handler: () => Response.json(getIngressConfigResult()),
    },
    {
      endpoint: "integrations/ingress/config",
      method: "PUT",
      policyKey: "integrations/ingress/config",
      summary: "Update ingress config",
      description: "Set the ingress public base URL and enabled state.",
      tags: ["config"],
      requestBody: z.object({
        publicBaseUrl: z.string(),
        enabled: z.boolean(),
      }),
      responseBody: z.object({
        enabled: z.boolean(),
        publicBaseUrl: z.string(),
        localGatewayTarget: z.string(),
        success: z.boolean(),
      }),
      handler: async ({ req }) => {
        try {
          const body = (await req.json()) as {
            publicBaseUrl?: string;
            enabled?: boolean;
          };
          const value = (body.publicBaseUrl ?? "").trim().replace(/\/+$/, "");
          const raw = loadRawConfig();
          const ingress = (raw?.ingress ?? {}) as Record<string, unknown>;
          ingress.publicBaseUrl = value || undefined;
          if (body.enabled !== undefined) {
            ingress.enabled = body.enabled;
          }
          saveRawConfig({ ...raw, ingress });

          const isEnabled = (ingress.enabled as boolean | undefined) ?? false;
          if (value && isEnabled) {
            setIngressPublicBaseUrl(value);
          } else {
            setIngressPublicBaseUrl(undefined);
          }

          return Response.json({
            enabled: isEnabled,
            publicBaseUrl: value,
            localGatewayTarget: computeGatewayTarget(),
            success: true,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ err }, "Failed to update ingress config via HTTP");
          return httpError("INTERNAL_ERROR", message, 500);
        }
      },
    },
  ];
}
