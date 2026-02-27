import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { getRootDir } from "../../credential-reader.js";
import { getLogger } from "../../logger.js";

const log = getLogger("feature-flags");

/**
 * Only allow keys matching `skills.<skillId>.enabled` for the initial rollout.
 * The skillId segment must be a non-empty string of lowercase alphanumeric chars,
 * hyphens, and underscores.
 */
const ALLOWED_KEY_RE = /^skills\.[a-z0-9_-]+\.enabled$/;

function getConfigPath(): string {
  return join(getRootDir(), "workspace", "config.json");
}

function readConfigFile(): Record<string, unknown> {
  const cfgPath = getConfigPath();
  try {
    const raw = readFileSync(cfgPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Atomically write the config file: write to a temporary file in the same
 * directory, then rename. This avoids partial-file corruption if the process
 * crashes mid-write.
 */
function writeConfigFileAtomic(data: Record<string, unknown>): void {
  const cfgPath = getConfigPath();
  const dir = dirname(cfgPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = join(dir, `.config.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, cfgPath);
}

export type FeatureFlagEntry = {
  key: string;
  enabled: boolean;
};

export function createFeatureFlagsGetHandler() {
  return async (_req: Request): Promise<Response> => {
    try {
      const config = readConfigFile();
      const flags: Record<string, boolean> = {};
      const raw = config.featureFlags;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof v === "boolean") {
            flags[k] = v;
          }
        }
      }

      const entries: FeatureFlagEntry[] = Object.entries(flags).map(
        ([key, enabled]) => ({ key, enabled }),
      );

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
        { error: "Invalid flag key format. Must match: skills.<skillId>.enabled" },
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
        { error: "\"enabled\" must be a boolean" },
        { status: 400 },
      );
    }

    try {
      const config = readConfigFile();

      // Preserve existing config keys; only update featureFlags
      const existingFlags =
        config.featureFlags && typeof config.featureFlags === "object" && !Array.isArray(config.featureFlags)
          ? (config.featureFlags as Record<string, unknown>)
          : {};

      config.featureFlags = { ...existingFlags, [flagKey]: enabled };

      writeConfigFileAtomic(config);

      log.info({ flagKey, enabled }, "Feature flag updated");

      return Response.json({ key: flagKey, enabled });
    } catch (err) {
      log.error({ err, flagKey }, "Failed to update feature flag");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}
