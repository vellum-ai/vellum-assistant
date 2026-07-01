import { z } from "zod";

import {
  loadFeatureFlagDefaults,
  isFlagDeclared,
} from "../../feature-flag-defaults.js";
import { readEnvFeatureFlagOverrides } from "../../feature-flag-env-overrides.js";
import { readRemoteFeatureFlags } from "../../feature-flag-remote-store.js";
import {
  normalizeStaleRemoteFlagValue,
  resolveAbsentFlagDefault,
} from "../../feature-flag-staged-rollout.js";
import {
  readPersistedFeatureFlags,
  writeFeatureFlag,
} from "../../feature-flag-store.js";
import { getLogger } from "../../logger.js";
import type { GatewayRouteDefinition } from "./types.js";

const log = getLogger("feature-flags");

/**
 * Only allow simple kebab-case keys (e.g., "browser", "ces-tools").
 */
const ALLOWED_KEY_RE = /^[a-z0-9][a-z0-9-]*$/;

// ---------------------------------------------------------------------------
// Zod schemas (source of truth for OpenAPI spec generation)
// ---------------------------------------------------------------------------

const FeatureFlagEntrySchema = z.object({
  key: z.string(),
  label: z.string(),
  enabled: z.union([z.boolean(), z.string()]),
  defaultEnabled: z.union([z.boolean(), z.string()]),
  description: z.string(),
});

const FeatureFlagsGetResponseSchema = z.object({
  flags: z.array(FeatureFlagEntrySchema),
});

const FeatureFlagPatchRequestSchema = z.object({
  enabled: z.union([z.boolean(), z.string()]),
});

const FeatureFlagPatchResponseSchema = z.object({
  key: z.string(),
  enabled: z.union([z.boolean(), z.string()]),
});

export type FeatureFlagEntry = z.infer<typeof FeatureFlagEntrySchema>;

// ---------------------------------------------------------------------------
// Route definitions (consumed by scripts/generate-openapi.ts)
// ---------------------------------------------------------------------------

export const ROUTES: GatewayRouteDefinition[] = [
  {
    path: "/v1/feature-flags",
    method: "get",
    operationId: "featureFlagsGet",
    summary: "List all feature flags",
    description: "Returns all feature flags with their current values.",
    tags: ["feature-flags"],
    responseBody: FeatureFlagsGetResponseSchema,
  },
  {
    path: "/v1/feature-flags/{flag_key}",
    method: "patch",
    operationId: "featureFlagsPatch",
    summary: "Update a feature flag",
    description: "Set the enabled state of a single feature flag.",
    tags: ["feature-flags"],
    pathParameters: [
      { name: "flag_key", description: "The kebab-case flag identifier" },
    ],
    requestBody: FeatureFlagPatchRequestSchema,
    responseBody: FeatureFlagPatchResponseSchema,
  },
];

export function createFeatureFlagsGetHandler() {
  return async (_req: Request): Promise<Response> => {
    try {
      const defaults = loadFeatureFlagDefaults();
      const persisted = readPersistedFeatureFlags();
      const remote = readRemoteFeatureFlags();
      const envOverrides = readEnvFeatureFlagOverrides();

      const entries: FeatureFlagEntry[] = [];
      for (const [key, def] of Object.entries(defaults)) {
        const persistedValue = persisted[key];
        const remoteValue = remote[key];
        // Route the remote/absent value through the staged-rollout helpers so
        // the reported `enabled` state matches the daemon IPC map (and the value
        // driving search): a stale staged-rollout `false` cached off-platform is
        // normalized, and an absent value fails safe to `false` on managed
        // instead of showing the `true` registry default.
        const base =
          persistedValue !== undefined
            ? persistedValue
            : remoteValue !== undefined
              ? normalizeStaleRemoteFlagValue(key, remoteValue)
              : resolveAbsentFlagDefault(key, def.defaultEnabled);
        const envValue = envOverrides[key];
        entries.push({
          key,
          label: def.label,
          enabled: envValue !== undefined ? envValue : base,
          defaultEnabled: def.defaultEnabled,
          description: def.description,
        });
      }

      return Response.json({ flags: entries });
    } catch (err) {
      log.error({ err }, "Failed to read feature flags");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

export function createFeatureFlagsPatchHandler(onFlagChanged?: () => void) {
  return async (req: Request, flagKey: string): Promise<Response> => {
    // Validate flagKey is non-empty and matches allowed key charset
    if (!flagKey) {
      return Response.json(
        { error: "Flag key must be non-empty" },
        { status: 400 },
      );
    }

    if (!ALLOWED_KEY_RE.test(flagKey)) {
      return Response.json(
        {
          error:
            "Invalid flag key format. Must be a simple kebab-case string (e.g., 'browser', 'ces-tools')",
        },
        { status: 400 },
      );
    }

    // Validate that the flag key exists in the defaults registry
    if (!isFlagDeclared(flagKey)) {
      return Response.json(
        {
          error: `Unknown flag key: "${flagKey}" is not declared in the defaults registry`,
        },
        { status: 400 },
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json(
        { error: "Request body must be valid JSON" },
        { status: 400 },
      );
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json(
        { error: "Request body must be a JSON object" },
        { status: 400 },
      );
    }

    const { enabled } = body as { enabled?: unknown };
    if (typeof enabled !== "boolean" && typeof enabled !== "string") {
      return Response.json(
        { error: '"enabled" must be a boolean or string' },
        { status: 400 },
      );
    }

    try {
      writeFeatureFlag(flagKey, enabled);
    } catch (err) {
      log.error({ err, flagKey }, "Failed to update feature flag");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }

    log.info({ flagKey, enabled }, "Feature flag updated");

    // Notify connected clients synchronously with the write. The
    // FeatureFlagWatcher also fires on the file change, but its fs.watch +
    // debounce can lag or miss atomic-rename writes, so emitting here is the
    // reliable path for API-driven flips. A notification failure must not fail
    // an already-committed write, so it is logged and swallowed.
    try {
      onFlagChanged?.();
    } catch (err) {
      log.warn({ err, flagKey }, "Feature flag change notification failed");
    }

    return Response.json({ key: flagKey, enabled });
  };
}
