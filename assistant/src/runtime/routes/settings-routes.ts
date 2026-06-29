/**
 * Route handlers for settings, identity/avatar, voice config,
 * OAuth connect, workspace files, tools, and diagnostics env vars.
 */

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { z } from "zod";

import { setImage } from "../../avatar/avatar-store.js";
import {
  getPlatformBaseUrl,
  setIngressPublicBaseUrl,
} from "../../config/env.js";
import { loadRawConfig, saveRawConfig } from "../../config/loader.js";
import { loadSkillCatalog } from "../../config/skills.js";
import { getGuardianDelivery } from "../../contacts/guardian-delivery-reader.js";
import { findConversation } from "../../daemon/conversation-registry.js";
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
import { resolveGuardianPersonaPath } from "../../prompts/persona-resolver.js";
import type { ToolDefinition } from "../../providers/types.js";
import { getSecureKeyAsync } from "../../security/secure-keys.js";
import { parseToolManifestFile } from "../../skills/tool-manifest.js";
import {
  type ManifestOverride,
  resolveExecutionTarget,
} from "../../tools/execution-target.js";
import {
  getAllTools,
  getEnabledTools,
  getTool,
  getToolOwner,
} from "../../tools/registry.js";
import {
  ACTIVITY_SKIP_SET,
  injectActivityField,
} from "../../tools/schema-transforms.js";
import { generateAvatarImage } from "../../tools/system/avatar-generator.js";
import { pathExists } from "../../util/fs.js";
import { getLogger } from "../../util/logger.js";
import { getAvatarImagePath, getWorkspaceDir } from "../../util/platform.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { publishAvatarChanged } from "../sync/resource-sync-events.js";
import { BadRequestError, InternalError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";
import { resolveWorkspacePath } from "./workspace-utils.js";

const log = getLogger("settings-routes");

// ---------------------------------------------------------------------------
// Voice config
// ---------------------------------------------------------------------------

function handleVoiceConfigUpdate({ body = {} }: RouteHandlerArgs) {
  const { activationKey } = body as { activationKey?: string };
  if (!activationKey) {
    throw new BadRequestError("activationKey is required");
  }
  const result = normalizeActivationKey(activationKey);
  if (!result.ok) {
    throw new BadRequestError(result.reason);
  }
  return { ok: true, activationKey: result.value };
}

// ---------------------------------------------------------------------------
// Avatar generation
// ---------------------------------------------------------------------------

async function handleGenerateAvatar({ body = {}, headers }: RouteHandlerArgs) {
  const { description } = body as { description?: string };
  if (!description?.trim()) {
    throw new BadRequestError("Description is required.");
  }

  log.info({ description }, "Generating avatar via HTTP request");

  try {
    const result = await generateAvatarImage(description);

    if (result.isError || !result.pngBuffer) {
      throw new InternalError(result.content);
    }

    // Route through the store so traits sidecars are cleared and the manifest
    // is recorded as an AI-sourced image atomically.
    setImage(result.pngBuffer, "ai");

    const avatarPath = getAvatarImagePath();

    publishAvatarChanged(headers?.["x-vellum-client-id"]?.trim() || undefined);

    return { ok: true, avatarPath };
  } catch (err) {
    if (err instanceof InternalError || err instanceof BadRequestError)
      throw err;
    const message = err instanceof Error ? err.message : String(err);
    log.error({ error: message }, "Avatar generation failed unexpectedly");
    throw new InternalError(message);
  }
}

// ---------------------------------------------------------------------------
// Client settings update (generic)
// ---------------------------------------------------------------------------

const SUPPORTED_CLIENT_SETTINGS_KEYS = new Set(["activationKey"]);

function handleClientSettingsUpdate({ body = {} }: RouteHandlerArgs) {
  const { key, value } = body as { key?: string; value?: string };
  if (!key || value === undefined) {
    throw new BadRequestError("key and value are required");
  }
  if (key === "activationKey") {
    const result = normalizeActivationKey(value);
    if (!result.ok) {
      throw new BadRequestError(result.reason);
    }
    return { ok: true, activationKey: result.value };
  }
  throw new BadRequestError(
    `Unsupported client setting key: "${key}". Supported keys: ${[...SUPPORTED_CLIENT_SETTINGS_KEYS].join(", ")}`,
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

async function handleOAuthConnectStart({ body = {} }: RouteHandlerArgs) {
  const { service, requestedScopes } = body as {
    service?: string;
    requestedScopes?: string[];
  };

  if (!service) {
    throw new BadRequestError("Missing required field: service");
  }

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
    throw new BadRequestError(
      `No client_id found for "${service}". Store it first via the credential vault.`,
    );
  }

  const providerRow = getProvider(service);
  const requiresSecret = !!providerRow?.requiresClientSecret;
  if (requiresSecret && !clientSecret) {
    throw new BadRequestError(
      `client_secret is required for "${service}" but not found in the credential store. Store it first via the credential vault.`,
    );
  }

  try {
    let authorizeUrl: string | undefined;

    const result = await orchestrateOAuthConnect({
      service,
      requestedScopes,
      clientId,
      clientSecret,
      callbackTransport: "loopback",
      isInteractive: true,
      openUrl: (url: string) => {
        authorizeUrl = url;
      },
      onDeferredComplete: (deferredResult) => {
        let accountInfo = deferredResult.accountInfo;
        try {
          const conn = getConnectionByProvider(service);
          if (conn?.accountInfo) accountInfo = conn.accountInfo;
        } catch {
          // DB not ready — use orchestrator value
        }

        assistantEventHub
          .publish(
            buildAssistantEvent({
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
      throw new InternalError(
        result.safeError ? result.error : sanitizeOAuthError(result.error),
      );
    }

    if (result.deferred) {
      return {
        ok: true,
        deferred: true,
        authUrl: result.authorizeUrl,
      };
    }

    let responseAccountInfo = result.accountInfo;
    try {
      const conn = getConnectionByProvider(service);
      if (conn?.accountInfo) responseAccountInfo = conn.accountInfo;
    } catch {
      // DB not ready — use orchestrator value
    }

    return {
      ok: true,
      grantedScopes: result.grantedScopes,
      accountInfo: responseAccountInfo,
      ...(authorizeUrl ? { authUrl: authorizeUrl } : {}),
    };
  } catch (err) {
    if (err instanceof InternalError || err instanceof BadRequestError)
      throw err;
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, service }, "OAuth connect flow failed");
    throw new InternalError(sanitizeOAuthError(message));
  }
}

// ---------------------------------------------------------------------------
// Workspace files (list/read)
// ---------------------------------------------------------------------------

async function getWorkspaceFiles(): Promise<string[]> {
  const files = ["IDENTITY.md", "SOUL.md", "skills/"];
  // Warm the vellum guardian-delivery cache so the sync persona resolution
  // below hits a fresh key instead of falling back to default.md on a cold or
  // TTL-expired cache.
  await getGuardianDelivery({ channelTypes: ["vellum"] });
  const guardianPath = resolveGuardianPersonaPath();
  if (guardianPath) {
    files.push(`users/${basename(guardianPath)}`);
  }
  return files;
}

async function handleWorkspaceFilesList() {
  const base = getWorkspaceDir();
  const files = (await getWorkspaceFiles()).map((name) => ({
    path: name,
    name,
    exists: pathExists(join(base, name)),
  }));
  return { type: "workspace_files_list_response", files };
}

function handleWorkspaceFileRead({ queryParams = {} }: RouteHandlerArgs) {
  const filePath = queryParams.path ?? "";
  if (!filePath) {
    throw new BadRequestError("path query parameter is required");
  }

  const resolved = resolveWorkspacePath(filePath);
  if (resolved === undefined) {
    throw new BadRequestError("Invalid path");
  }

  try {
    if (!pathExists(resolved)) {
      throw new NotFoundError("File not found");
    }
    const content = readFileSync(resolved, "utf-8");
    return { path: filePath, content };
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof BadRequestError)
      throw err;
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, path: filePath }, "Failed to read workspace file");
    throw new InternalError(message);
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

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

type SchemaShape = {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
};

interface ToolNamesListResponse {
  names: string[];
  schemas: Record<string, SchemaShape>;
  tools: ToolListEntry[];
}

/**
 * Tool inventory. With no `conversationId`, reports every tool in the
 * global registry that is currently active — tools contributed by a
 * disabled plugin are filtered out at read time, so the listing matches
 * what conversations can actually call (plus skill-manifest tools not yet
 * loaded, for the permission-simulator catalog). With a `conversationId`,
 * scopes the inventory to the tools available to that conversation as of
 * its most recent turn — see {@link handleConversationToolList}.
 */
function handleToolNamesList(conversationId?: string): ToolNamesListResponse {
  if (conversationId) {
    return handleConversationToolList(conversationId);
  }

  const tools = getEnabledTools();
  const nameSet = new Set(tools.map((t) => t.name));
  const schemas: Record<string, SchemaShape> = {};

  const rawDefs: ToolDefinition[] = tools;

  const transformedDefs = injectActivityField(rawDefs, ACTIVITY_SKIP_SET);
  for (const def of transformedDefs) {
    schemas[def.name] = def.input_schema as SchemaShape;
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
  return { names, schemas, tools: buildRegisteredToolEntries() };
}

/**
 * Scope the tool inventory to a single conversation. Conversations gain
 * tools over their lifecycle (skill loads, MCP reloads), so the global
 * registry over-reports what a given conversation can actually call. We
 * read the conversation's turn snapshot (`getRegisteredToolNames()`) — a
 * pure read that does not re-run the side-effecting `resolveTools`
 * callback — and resolve each name's metadata/schema from the registry.
 */
function handleConversationToolList(
  conversationId: string,
): ToolNamesListResponse {
  const conversation = findConversation(conversationId);
  if (!conversation) {
    throw new NotFoundError(
      `No active conversation "${conversationId}". Run 'assistant conversations list' to see active conversations.`,
    );
  }

  const names = Array.from(conversation.getRegisteredToolNames()).sort((a, b) =>
    a.localeCompare(b),
  );

  const schemaByName = new Map<string, SchemaShape>(
    injectActivityField(getAllTools(), ACTIVITY_SKIP_SET).map((d) => [
      d.name,
      d.input_schema as SchemaShape,
    ]),
  );

  const schemas: Record<string, SchemaShape> = {};
  const tools: ToolListEntry[] = [];
  for (const name of names) {
    const schema = schemaByName.get(name);
    if (schema) schemas[name] = schema;
    tools.push(toolEntryForName(name));
  }

  return { names, schemas, tools };
}

interface ToolListEntry {
  name: string;
  description: string;
  riskLevel: string;
  category: string;
  /** Tool origin: "core" for built-ins, otherwise "<kind>:<id>" (e.g. "plugin:echo"). */
  source: string;
}

/**
 * Build a catalog entry for one tool name, reading metadata and ownership
 * from the registry (the single source of truth) rather than off any
 * caller-supplied object, so `source` cannot be spoofed by a manifest
 * field. `source` is `core` for built-ins, `<kind>:<id>` for an owned tool
 * (e.g. `plugin:echo`), and `unknown` for a name no longer in the registry
 * (e.g. a conversation snapshot referencing a since-unloaded skill tool).
 */
function toolEntryForName(name: string): ToolListEntry {
  const tool = getTool(name);
  const owner = getToolOwner(name);
  return {
    name,
    description: tool?.description ?? "",
    riskLevel: tool?.defaultRiskLevel ?? "unknown",
    category: tool?.category ?? "",
    source: owner ? `${owner.kind}:${owner.id}` : tool ? "core" : "unknown",
  };
}

/**
 * Build the registered-tool inventory with the metadata a catalog view
 * needs: description, author-asserted risk band, category, and the
 * extension that contributed the tool. Sorted by name for stable output.
 * Covers only tools loaded into the registry and currently active; tools
 * from a disabled plugin are excluded (see {@link getEnabledTools}), and
 * skill tools whose manifests are present but not yet loaded appear in
 * `names`/`schemas` but not here.
 */
function buildRegisteredToolEntries(): ToolListEntry[] {
  return getEnabledTools()
    .map((tool) => toolEntryForName(tool.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function handleToolPermissionSimulate({ body = {} }: RouteHandlerArgs) {
  const {
    toolName,
    input,
    workingDir: rawWorkingDir,
    isInteractive,
  } = body as {
    toolName?: string;
    input?: Record<string, unknown>;
    workingDir?: string;
    isInteractive?: boolean;
  };

  if (!toolName || typeof toolName !== "string") {
    throw new BadRequestError("toolName is required");
  }
  if (!input || typeof input !== "object") {
    throw new BadRequestError("input is required and must be an object");
  }

  const workingDir = rawWorkingDir ?? process.cwd();

  try {
    const manifestOverride = resolveManifestOverride(toolName);
    // Permission Simulator path: registered tool wins, then explicit
    // manifest override, then the standard inference rules.
    const executionTarget =
      getTool(toolName)?.executionTarget ??
      manifestOverride?.execution_target ??
      resolveExecutionTarget({ name: toolName });
    const executionContext =
      isInteractive === false ? "headless" : "conversation";
    const policyContext = { executionTarget, executionContext } as const;

    const { level: riskLevel } = await classifyRisk(
      toolName,
      input,
      workingDir,
      undefined,
      manifestOverride,
    );
    const result = await check(
      toolName,
      input,
      workingDir,
      policyContext,
      manifestOverride,
    );

    if (isInteractive === false && result.decision === "prompt") {
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
      const allowlistOptions = await generateAllowlistOptions(toolName, input);
      const scopeOptions = generateScopeOptions(workingDir, toolName);
      promptPayload = {
        allowlistOptions,
        scopeOptions,
        persistentDecisionsAllowed: true,
      };
    }

    return {
      success: true,
      decision: result.decision,
      riskLevel,
      reason: result.reason,
      executionTarget,
      matchedTrustRuleId: result.matchedRule?.id,
      promptPayload,
    };
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to simulate tool permission");
    throw new InternalError(message);
  }
}

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------

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

function handleEnvVars() {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && isEnvVarSafe(key)) {
      vars[key] = value;
    }
  }
  return { vars };
}

// ---------------------------------------------------------------------------
// Platform config
// ---------------------------------------------------------------------------

function handleGetPlatformConfig() {
  const raw = loadRawConfig();
  const platform = (raw?.platform ?? {}) as Record<string, unknown>;
  const baseUrl =
    (platform.baseUrl as string | undefined) || getPlatformBaseUrl();
  return { baseUrl, success: true };
}

function handleUpdatePlatformConfig({ body = {} }: RouteHandlerArgs) {
  try {
    const { baseUrl: rawBaseUrl } = body as { baseUrl?: string };
    const value = (rawBaseUrl ?? "").trim().replace(/\/+$/, "");
    const raw = loadRawConfig();
    const platform = (raw?.platform ?? {}) as Record<string, unknown>;
    platform.baseUrl = value || undefined;
    saveRawConfig({ ...raw, platform });
    return { baseUrl: value, success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to update platform config");
    throw new InternalError(message);
  }
}

// ---------------------------------------------------------------------------
// Ingress config
// ---------------------------------------------------------------------------

function handleUpdateIngressConfig({ body = {} }: RouteHandlerArgs) {
  try {
    const { publicBaseUrl: rawUrl, enabled } = body as {
      publicBaseUrl?: string;
      enabled?: boolean;
    };
    const value = (rawUrl ?? "").trim().replace(/\/+$/, "");
    const raw = loadRawConfig();
    const ingress = (raw?.ingress ?? {}) as Record<string, unknown>;
    ingress.publicBaseUrl = value || undefined;
    if (enabled !== undefined) {
      ingress.enabled = enabled;
    }
    saveRawConfig({ ...raw, ingress });

    const isEnabled = (ingress.enabled as boolean | undefined) ?? false;
    if (value && isEnabled) {
      setIngressPublicBaseUrl(value);
    } else {
      setIngressPublicBaseUrl(undefined);
    }

    return {
      enabled: isEnabled,
      publicBaseUrl: value,
      localGatewayTarget: computeGatewayTarget(),
      success: true,
    };
  } catch (err) {
    if (err instanceof InternalError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to update ingress config");
    throw new InternalError(message);
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "settings_voice_put",
    endpoint: "settings/voice",
    method: "PUT",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Update voice activation key",
    description: "Validate and normalize a voice activation key.",
    tags: ["settings"],
    requestBody: z.object({
      activationKey: z.string(),
    }),
    handler: handleVoiceConfigUpdate,
  },
  {
    operationId: "settings_avatar_generate_post",
    endpoint: "settings/avatar/generate",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Generate avatar",
    description: "Generate an AI avatar image from a text description.",
    tags: ["settings"],
    requestBody: z.object({
      description: z.string(),
    }),
    handler: handleGenerateAvatar,
  },
  {
    operationId: "settings_client_put",
    endpoint: "settings/client",
    method: "PUT",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Update client setting",
    description: "Set a single client-side setting key/value pair.",
    tags: ["settings"],
    requestBody: z.object({
      key: z.string(),
      value: z.string(),
    }),
    handler: handleClientSettingsUpdate,
  },
  {
    operationId: "oauth_start_post",
    endpoint: "oauth/start",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Start OAuth flow",
    description:
      "Initiate an OAuth authorization flow for a third-party service.",
    tags: ["oauth"],
    requestBody: z.object({
      service: z.string(),
      requestedScopes: z.array(z.unknown()),
    }),
    handler: handleOAuthConnectStart,
  },
  {
    operationId: "integrations_oauth_start_post",
    endpoint: "integrations/oauth/start",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Start OAuth flow (legacy)",
    description: "Legacy alias for oauth/start.",
    tags: ["oauth"],
    requestBody: z.object({
      service: z.string(),
      requestedScopes: z.array(z.unknown()),
    }),
    handler: handleOAuthConnectStart,
  },
  {
    operationId: "workspacefiles_get",
    endpoint: "workspace-files",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List workspace files",
    description: "Return an array of files in the workspace directory.",
    tags: ["workspace"],
    handler: () => handleWorkspaceFilesList(),
  },
  {
    operationId: "workspacefiles_read_get",
    endpoint: "workspace-files/read",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Read a workspace file",
    description: "Return the contents of a single file by path.",
    tags: ["workspace"],
    queryParams: [
      {
        name: "path",
        type: "string",
        required: true,
        description: "File path to read",
      },
    ],
    handler: handleWorkspaceFileRead,
  },
  {
    operationId: "tools_get",
    endpoint: "tools",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List registered tools with metadata and schemas",
    description:
      "Return registered tools. Without `conversationId`, returns every tool in the global registry; `tools` carries per-tool metadata (description, author-asserted risk level, category, and contributing source: core, skill, plugin, or MCP server) and `names`/`schemas` additionally cover skill tools whose manifests are present but not yet loaded, for the permission-simulator catalog. With `conversationId`, scopes the result to the tools available to that conversation as of its most recent turn (including skill/MCP tools registered over its lifecycle); 404 if no such conversation is active.",
    tags: ["tools"],
    queryParams: [
      {
        name: "conversationId",
        type: "string",
        required: false,
        description:
          "When set, scope the tool inventory to this conversation's most recent turn instead of the global registry.",
      },
    ],
    responseBody: z.object({
      names: z.array(z.string()),
      schemas: z.record(z.string(), z.record(z.string(), z.unknown())),
      tools: z.array(
        z.object({
          name: z.string(),
          description: z.string(),
          riskLevel: z.string(),
          category: z.string(),
          source: z
            .string()
            .describe(
              'Tool origin: "core" for built-ins, otherwise "<kind>:<id>" (e.g. "plugin:echo", "skill:my-skill", "mcp:server").',
            ),
        }),
      ),
    }),
    handler: ({ queryParams }) =>
      handleToolNamesList(queryParams?.conversationId),
  },
  {
    operationId: "tools_simulate_permission_post",
    endpoint: "tools/simulate-permission",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Simulate tool permission check",
    description:
      "Dry-run a permission check for a tool invocation without executing it.",
    tags: ["tools"],
    requestBody: z.object({
      toolName: z.string(),
      input: z.object({}).passthrough(),
      workingDir: z.string(),
      isInteractive: z.boolean(),
    }),
    handler: handleToolPermissionSimulate,
  },
  {
    operationId: "diagnostics_envvars_get",
    endpoint: "diagnostics/env-vars",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List safe environment variables",
    description:
      "Return environment variable names and values that are safe to expose (no secrets).",
    tags: ["diagnostics"],
    handler: () => handleEnvVars(),
  },
  {
    operationId: "config_platform_get",
    endpoint: "config/platform",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get platform config",
    description: "Return the platform base URL configuration.",
    tags: ["config"],
    responseBody: z.object({
      baseUrl: z.string(),
      success: z.boolean(),
    }),
    handler: () => handleGetPlatformConfig(),
  },
  {
    operationId: "config_platform_put",
    endpoint: "config/platform",
    method: "PUT",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Update platform config",
    description: "Set the platform base URL.",
    tags: ["config"],
    requestBody: z.object({
      baseUrl: z.string(),
    }),
    handler: handleUpdatePlatformConfig,
  },
  {
    operationId: "integrations_ingress_config_get",
    endpoint: "integrations/ingress/config",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get ingress config",
    description: "Return the current ingress tunnel configuration.",
    tags: ["config"],
    handler: () => getIngressConfigResult(),
  },
  {
    operationId: "integrations_ingress_config_put",
    endpoint: "integrations/ingress/config",
    method: "PUT",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
      managedCallbacks: z.boolean().optional(),
      success: z.boolean(),
    }),
    handler: handleUpdateIngressConfig,
  },
];
