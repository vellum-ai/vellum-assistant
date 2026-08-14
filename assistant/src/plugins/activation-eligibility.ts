import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import semver from "semver";
import { z } from "zod";

import assistantPkg from "../../package.json" with { type: "json" };
import {
  findUnsatisfiedHostCapabilities,
  HOST_REQUIREMENTS_FILENAME,
  readHostRequirements,
  type UnsatisfiedHostCapability,
} from "./host-requirements.js";
import { getFileSignature } from "./surface-import.js";

const PLUGIN_API_PEER_DEP = "@vellumai/plugin-api";

const PackageCompatibilitySchema = z
  .object({
    peerDependencies: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export type PluginIncompatibilityCode =
  | "host_requirements_invalid"
  | "plugin_manifest_invalid"
  | "plugin_api_peer_missing"
  | "plugin_api_peer_invalid"
  | "plugin_api_peer_unsatisfied"
  | "host_capability_unsatisfied";

export type PluginActivationEligibility =
  | {
      readonly eligible: true;
      readonly mode: "legacy" | "requirements";
      readonly pluginId: string;
      readonly pluginApiRange?: string;
    }
  | {
      readonly eligible: false;
      readonly pluginId: string;
      readonly code: PluginIncompatibilityCode;
      readonly reason: string;
      readonly pluginApiRange?: string;
      readonly missingCapabilities?: readonly UnsatisfiedHostCapability[];
    };

interface CachedEligibility {
  readonly packageSignature: string;
  readonly requirementsSignature: string;
  readonly value: PluginActivationEligibility;
}

const cache = new Map<string, CachedEligibility>();

function incompatible(
  pluginId: string,
  code: PluginIncompatibilityCode,
  reason: string,
  extras: Pick<
    Extract<PluginActivationEligibility, { eligible: false }>,
    "pluginApiRange" | "missingCapabilities"
  > = {},
): PluginActivationEligibility {
  return { eligible: false, pluginId, code, reason, ...extras };
}

export function evaluatePluginActivation(
  pluginDir: string,
): PluginActivationEligibility {
  const pluginId = basename(pluginDir);
  const requirements = readHostRequirements(pluginDir);
  if (requirements.kind === "legacy") {
    return { eligible: true, mode: "legacy", pluginId };
  }
  if (requirements.kind === "invalid") {
    return incompatible(
      pluginId,
      "host_requirements_invalid",
      requirements.reason,
    );
  }

  let rawPackage: unknown;
  try {
    rawPackage = JSON.parse(
      readFileSync(join(pluginDir, "package.json"), "utf8"),
    );
  } catch (err) {
    return incompatible(
      pluginId,
      "plugin_manifest_invalid",
      err instanceof Error ? err.message : String(err),
    );
  }

  const parsedPackage = PackageCompatibilitySchema.safeParse(rawPackage);
  if (!parsedPackage.success) {
    return incompatible(
      pluginId,
      "plugin_manifest_invalid",
      parsedPackage.error.message,
    );
  }

  const pluginApiRange =
    parsedPackage.data.peerDependencies?.[PLUGIN_API_PEER_DEP];
  if (pluginApiRange === undefined) {
    return incompatible(
      pluginId,
      "plugin_api_peer_missing",
      `package.json must declare peerDependencies[${JSON.stringify(PLUGIN_API_PEER_DEP)}] when host-requirements.json is present`,
    );
  }
  if (semver.validRange(pluginApiRange) === null) {
    return incompatible(
      pluginId,
      "plugin_api_peer_invalid",
      `plugin API peer range ${JSON.stringify(pluginApiRange)} is invalid`,
      { pluginApiRange },
    );
  }
  if (
    !semver.satisfies(assistantPkg.version, pluginApiRange, {
      includePrerelease: true,
    })
  ) {
    return incompatible(
      pluginId,
      "plugin_api_peer_unsatisfied",
      `plugin API peer range ${JSON.stringify(pluginApiRange)} does not include assistant ${assistantPkg.version}`,
      { pluginApiRange },
    );
  }

  const missingCapabilities = findUnsatisfiedHostCapabilities(
    requirements.requirements,
  );
  if (missingCapabilities.length > 0) {
    return incompatible(
      pluginId,
      "host_capability_unsatisfied",
      "one or more required host capabilities are unavailable",
      { pluginApiRange, missingCapabilities },
    );
  }

  return {
    eligible: true,
    mode: "requirements",
    pluginId,
    pluginApiRange,
  };
}

export function getPluginActivationEligibility(
  pluginDir: string,
): PluginActivationEligibility {
  const packagePath = join(pluginDir, "package.json");
  const requirementsPath = join(pluginDir, HOST_REQUIREMENTS_FILENAME);
  const packageSignature = getFileSignature(packagePath);
  const requirementsSignature = getFileSignature(requirementsPath);
  const cached = cache.get(pluginDir);
  if (
    cached?.packageSignature === packageSignature &&
    cached.requirementsSignature === requirementsSignature
  ) {
    return cached.value;
  }

  const value = evaluatePluginActivation(pluginDir);
  cache.set(pluginDir, { packageSignature, requirementsSignature, value });
  return value;
}

/** Drop the cached compatibility decision for one plugin directory. */
export function evictPluginActivationEligibility(pluginDir: string): void {
  cache.delete(pluginDir);
}

export function resetPluginActivationEligibilityCacheForTests(): void {
  cache.clear();
}
