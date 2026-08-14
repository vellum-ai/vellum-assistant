import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import semver from "semver";
import { z } from "zod";

import {
  resolveHostCapabilityVersion,
  satisfiesHostCapability,
} from "./host-capabilities.js";

export const HOST_REQUIREMENTS_FILENAME = "host-requirements.json";

const CAPABILITY_ID = /^[a-z][a-z0-9.-]{0,127}$/;

export const HostRequirementsSchema = z
  .object({
    schemaVersion: z.literal(1),
    requires: z.record(
      z.string().regex(CAPABILITY_ID),
      z.string().min(1).max(128),
    ),
  })
  .strict();

export type HostRequirements = z.infer<typeof HostRequirementsSchema>;

export type HostRequirementsReadResult =
  | { readonly kind: "legacy" }
  | { readonly kind: "valid"; readonly requirements: HostRequirements }
  | { readonly kind: "invalid"; readonly reason: string };

export interface UnsatisfiedHostCapability {
  readonly id: string;
  readonly requiredRange: string;
  readonly hostVersion?: string;
}

export function readHostRequirements(
  pluginDir: string,
): HostRequirementsReadResult {
  const path = join(pluginDir, HOST_REQUIREMENTS_FILENAME);
  if (!existsSync(path)) {
    return { kind: "legacy" };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return {
      kind: "invalid",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const parsed = HostRequirementsSchema.safeParse(raw);
  if (!parsed.success) {
    return { kind: "invalid", reason: parsed.error.message };
  }

  for (const [id, range] of Object.entries(parsed.data.requires)) {
    if (semver.validRange(range) === null) {
      return {
        kind: "invalid",
        reason: `capability ${id} has invalid semver range ${JSON.stringify(range)}`,
      };
    }
  }

  return { kind: "valid", requirements: parsed.data };
}

export function findUnsatisfiedHostCapabilities(
  requirements: HostRequirements,
): UnsatisfiedHostCapability[] {
  const missing: UnsatisfiedHostCapability[] = [];
  for (const [id, requiredRange] of Object.entries(requirements.requires)) {
    if (!satisfiesHostCapability(id, requiredRange)) {
      missing.push({
        id,
        requiredRange,
        hostVersion: resolveHostCapabilityVersion(id),
      });
    }
  }
  return missing;
}
