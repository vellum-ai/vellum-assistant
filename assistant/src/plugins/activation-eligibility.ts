import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import semver from "semver";
import { z } from "zod";

import assistantPkg from "../../package.json" with { type: "json" };
import { ASSISTANT_PEER_ROUTES_CAPABILITY_ID } from "./host-capabilities.js";
import {
  findUnsatisfiedHostCapabilities,
  HOST_REQUIREMENTS_FILENAME,
  readHostRequirements,
  type UnsatisfiedHostCapability,
} from "./host-requirements.js";
import {
  PLUGIN_ROUTE_MANIFEST_PATH,
  readPluginRouteManifest,
} from "./plugin-route-manifest.js";

const PLUGIN_API_PEER_DEP = "@vellumai/plugin-api";
const MAX_SIGNATURE_FILE_BYTES = 1024 * 1024;

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
  readonly routeManifestSignature: string;
  readonly value: PluginActivationEligibility;
}

const cache = new Map<string, CachedEligibility>();

interface BoundedContentSignature {
  readonly value: string;
  readonly oversized: boolean;
}

function getContentSignature(path: string): BoundedContentSignature {
  try {
    const content = readFileSync(path);
    if (content.byteLength > MAX_SIGNATURE_FILE_BYTES) {
      return { value: `oversized:${content.byteLength}`, oversized: true };
    }
    return {
      value: createHash("sha256").update(content).digest("hex"),
      oversized: false,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      value: code === "ENOENT" ? "missing" : `unreadable:${code ?? "unknown"}`,
      oversized: false,
    };
  }
}

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

function evaluatePluginActivation(
  pluginDir: string,
): PluginActivationEligibility {
  const pluginId = basename(pluginDir);
  const requirements = readHostRequirements(pluginDir);
  if (requirements.kind === "invalid") {
    return incompatible(
      pluginId,
      "host_requirements_invalid",
      requirements.reason,
    );
  }

  const routeManifest = readPluginRouteManifest(pluginDir);
  const declaresAssistantPeerRoute =
    routeManifest.kind === "valid" &&
    routeManifest.manifest.routes.some(
      (route) => route.authorization.principal === "assistant_peer",
    );
  if (declaresAssistantPeerRoute) {
    if (requirements.kind === "legacy") {
      return incompatible(
        pluginId,
        "host_requirements_invalid",
        `assistant-peer routes require host-requirements.json to declare ${ASSISTANT_PEER_ROUTES_CAPABILITY_ID}`,
      );
    }
    if (
      requirements.requirements.requires[
        ASSISTANT_PEER_ROUTES_CAPABILITY_ID
      ] === undefined
    ) {
      return incompatible(
        pluginId,
        "host_requirements_invalid",
        `assistant-peer routes require capability ${ASSISTANT_PEER_ROUTES_CAPABILITY_ID}`,
      );
    }
  }

  if (requirements.kind === "legacy") {
    return { eligible: true, mode: "legacy", pluginId };
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
  const routeManifestPath = join(pluginDir, PLUGIN_ROUTE_MANIFEST_PATH);
  const packageContent = getContentSignature(packagePath);
  const requirementsContent = getContentSignature(requirementsPath);
  const routeManifestContent = getContentSignature(routeManifestPath);
  const packageSignature = packageContent.value;
  const requirementsSignature = requirementsContent.value;
  const routeManifestSignature = routeManifestContent.value;
  const cached = cache.get(pluginDir);
  if (
    cached?.packageSignature === packageSignature &&
    cached.requirementsSignature === requirementsSignature &&
    cached.routeManifestSignature === routeManifestSignature
  ) {
    return cached.value;
  }

  let value: PluginActivationEligibility;
  if (requirementsContent.oversized) {
    value = incompatible(
      basename(pluginDir),
      "host_requirements_invalid",
      `host-requirements.json exceeds ${MAX_SIGNATURE_FILE_BYTES} bytes`,
    );
  } else if (requirementsSignature !== "missing" && packageContent.oversized) {
    value = incompatible(
      basename(pluginDir),
      "plugin_manifest_invalid",
      `package.json exceeds ${MAX_SIGNATURE_FILE_BYTES} bytes`,
    );
  } else {
    value = evaluatePluginActivation(pluginDir);
  }
  cache.set(pluginDir, {
    packageSignature,
    requirementsSignature,
    routeManifestSignature,
    value,
  });
  return value;
}

/** Drop the cached compatibility decision for one plugin directory. */
export function evictPluginActivationEligibility(pluginDir: string): void {
  cache.delete(pluginDir);
}

export function resetPluginActivationEligibilityCacheForTests(): void {
  cache.clear();
}
