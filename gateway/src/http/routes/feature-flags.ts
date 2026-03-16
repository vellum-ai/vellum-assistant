import {
  loadFeatureFlagDefaults,
  isFlagDeclared,
} from "../../feature-flag-defaults.js";
import { getLogger } from "../../logger.js";
import {
  enqueueConfigWrite,
  readConfigFile,
  writeConfigFileAtomic,
} from "./config-file-utils.js";

const log = getLogger("feature-flags");

/**
 * Only allow keys matching `feature_flags.<flagId>.enabled` for the canonical format.
 * The flagId segment must be a non-empty string of lowercase alphanumeric chars,
 * dots, hyphens, and underscores.
 */
const ALLOWED_KEY_RE = /^feature_flags\.[a-z0-9][a-z0-9._-]*\.enabled$/;

/**
 * Read persisted flag values from the canonical config section.
 * Returns a map of canonical key -> boolean value.
 */
function readPersistedFlags(
  config: Record<string, unknown>,
): Map<string, boolean> {
  const result = new Map<string, boolean>();

  // Read `assistantFeatureFlagValues` section
  const newRaw = config.assistantFeatureFlagValues;
  if (newRaw && typeof newRaw === "object" && !Array.isArray(newRaw)) {
    for (const [k, v] of Object.entries(newRaw as Record<string, unknown>)) {
      if (typeof v !== "boolean") continue;
      if (ALLOWED_KEY_RE.test(k)) {
        result.set(k, v);
      }
    }
  }

  return result;
}

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
      const result = readConfigFile();
      // For GET, a malformed config degrades gracefully to empty persisted values
      const config = result.ok ? result.data : {};
      const persisted = readPersistedFlags(config);

      // Build entries for ALL declared flags, merging persisted values
      const entries: FeatureFlagEntry[] = [];
      for (const [key, def] of Object.entries(defaults)) {
        const persistedValue = persisted.get(key);
        entries.push({
          key,
          label: def.label,
          enabled:
            persistedValue !== undefined ? persistedValue : def.defaultEnabled,
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
            "Invalid flag key format. Must match: feature_flags.<flagId>.enabled",
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

    // Serialize config writes to prevent concurrent read-modify-write races
    const writeResult = new Promise<Response>((resolve) => {
      enqueueConfigWrite(() => {
        try {
          const result = readConfigFile();
          if (!result.ok) {
            log.error(
              { reason: result.reason, detail: result.detail },
              "Config file is malformed, refusing to overwrite",
            );
            resolve(
              Response.json(
                { error: "Config file is malformed, cannot safely write" },
                { status: 500 },
              ),
            );
            return;
          }

          const config = result.data;

          // Write to the `assistantFeatureFlagValues` section
          const existingNewFlags =
            config.assistantFeatureFlagValues &&
            typeof config.assistantFeatureFlagValues === "object" &&
            !Array.isArray(config.assistantFeatureFlagValues)
              ? (config.assistantFeatureFlagValues as Record<string, unknown>)
              : {};

          config.assistantFeatureFlagValues = {
            ...existingNewFlags,
            [flagKey]: enabled,
          };

          writeConfigFileAtomic(config);

          log.info({ flagKey, enabled }, "Feature flag updated");

          resolve(Response.json({ key: flagKey, enabled }));
        } catch (err) {
          log.error({ err, flagKey }, "Failed to update feature flag");
          resolve(
            Response.json({ error: "Internal server error" }, { status: 500 }),
          );
        }
      });
    });

    return writeResult;
  };
}
