import {
  loadFeatureFlagDefaults,
  isFlagDeclared,
} from "../../feature-flag-defaults.js";
import { readRemoteFeatureFlags } from "../../feature-flag-remote-store.js";
import {
  readPersistedFeatureFlags,
  writeFeatureFlag,
} from "../../feature-flag-store.js";
import { getLogger } from "../../logger.js";

const log = getLogger("feature-flags");

/**
 * Only allow simple kebab-case keys (e.g., "browser", "ces-tools").
 */
const ALLOWED_KEY_RE = /^[a-z0-9][a-z0-9-]*$/;

export type FeatureFlagEntry = {
  key: string;
  label: string;
  enabled: boolean;
  defaultEnabled: boolean;
  description: string;
};

export function createFeatureFlagsGetHandler() {
  return async (_req: Request): Promise<Response> => {
    try {
      const defaults = loadFeatureFlagDefaults();
      const persisted = readPersistedFeatureFlags();
      const remote = readRemoteFeatureFlags();

      // Build entries for ALL declared flags, merging persisted values
      const entries: FeatureFlagEntry[] = [];
      for (const [key, def] of Object.entries(defaults)) {
        const persistedValue = persisted[key];
        entries.push({
          key,
          label: def.label,
          enabled:
            persistedValue !== undefined
              ? persistedValue
              : remote[key] !== undefined
                ? remote[key]
                : def.defaultEnabled,
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

export function createFeatureFlagsPatchHandler() {
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
    if (typeof enabled !== "boolean") {
      return Response.json(
        { error: '"enabled" must be a boolean' },
        { status: 400 },
      );
    }

    try {
      writeFeatureFlag(flagKey, enabled);
      log.info({ flagKey, enabled }, "Feature flag updated");
      return Response.json({ key: flagKey, enabled });
    } catch (err) {
      log.error({ err, flagKey }, "Failed to update feature flag");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}
