import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  PLUGIN_READINESS_FILENAME,
  type PluginReadinessEntry,
  type PluginReadinessSnapshot,
  PluginReadinessSnapshotSchema,
} from "@vellumai/service-contracts/plugin-readiness";

import { getWorkspaceDir } from "../util/platform.js";
import {
  getPluginActivationEligibility,
  type PluginActivationEligibility,
} from "./activation-eligibility.js";
import {
  derivePluginSourceFingerprint,
  snapshotPluginSource,
} from "./source-fingerprint.js";
import { getFileSignature } from "./surface-import.js";
export { derivePluginSourceFingerprint } from "./source-fingerprint.js";

let snapshot: PluginReadinessSnapshot = createSnapshot();
let durableReadsEnabled =
  process.env.BUN_TEST !== "1" && process.env.NODE_ENV !== "test";
let durableSnapshotCache:
  | {
      readonly path: string;
      readonly signature: string;
      readonly value: PluginReadinessSnapshot | undefined;
    }
  | undefined;
const sourceFingerprintCache = new Map<
  string,
  { readonly checkedAt: number; readonly fingerprint: string }
>();
const SOURCE_FINGERPRINT_CACHE_MS = 1_000;

function createSnapshot(): PluginReadinessSnapshot {
  return { schemaVersion: 1, generation: randomUUID(), plugins: {} };
}

export function getPluginReadinessPath(
  workspaceDir = getWorkspaceDir(),
): string {
  return join(workspaceDir, "data", PLUGIN_READINESS_FILENAME);
}

function persistSnapshot(): void {
  const path = getPluginReadinessPath();
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  renameSync(tempPath, path);
}

function update(entry: PluginReadinessEntry): void {
  const current = snapshot.plugins[entry.pluginId];
  if (
    current?.sourceFingerprint === entry.sourceFingerprint &&
    current.status === entry.status &&
    current.code === entry.code &&
    current.message === entry.message
  ) {
    return;
  }
  snapshot = {
    ...snapshot,
    plugins: { ...snapshot.plugins, [entry.pluginId]: entry },
  };
  persistSnapshot();
}

export function resetPluginReadinessForBoot(): void {
  snapshot = createSnapshot();
  persistSnapshot();
}

export function markPluginInitializing(
  pluginId: string,
  sourceFingerprint: string,
): void {
  update({
    pluginId,
    sourceFingerprint,
    status: "initializing",
    updatedAt: new Date().toISOString(),
  });
}

export function markPluginReady(
  pluginId: string,
  sourceFingerprint: string,
): void {
  update({
    pluginId,
    sourceFingerprint,
    status: "ready",
    updatedAt: new Date().toISOString(),
  });
}

export function markPluginIncompatible(
  eligibility: Extract<PluginActivationEligibility, { eligible: false }>,
  sourceFingerprint: string,
): void {
  update({
    pluginId: eligibility.pluginId,
    sourceFingerprint,
    status: "incompatible",
    code: eligibility.code,
    message: eligibility.reason,
    updatedAt: new Date().toISOString(),
  });
}

export function markPluginFailed(
  pluginId: string,
  sourceFingerprint: string,
  message: string,
): void {
  update({
    pluginId,
    sourceFingerprint,
    status: "failed",
    code: "plugin_initialization_failed",
    message,
    updatedAt: new Date().toISOString(),
  });
}

export function removePluginReadiness(pluginId: string): void {
  if (!(pluginId in snapshot.plugins)) {
    return;
  }
  const plugins = { ...snapshot.plugins };
  delete plugins[pluginId];
  snapshot = { ...snapshot, plugins };
  persistSnapshot();
}

export function getPluginReadiness(
  pluginId: string,
): PluginReadinessEntry | undefined {
  return snapshot.plugins[pluginId];
}

export function isPluginReady(pluginId: string): boolean {
  return getPluginReadiness(pluginId)?.status === "ready";
}

export type PluginSurfaceActivation =
  | { readonly status: "ready" }
  | {
      readonly status: "initializing" | "incompatible" | "failed";
      readonly code: string;
      readonly message: string;
    };

/** Resolve whether an installed plugin may contribute disk-backed surfaces. */
export function getPluginSurfaceActivation(
  pluginId: string,
  pluginDir: string,
): PluginSurfaceActivation {
  const eligibility = getPluginActivationEligibility(pluginDir);
  if (!eligibility.eligible) {
    return {
      status: "incompatible",
      code: eligibility.code,
      message: eligibility.reason,
    };
  }
  if (eligibility.mode === "legacy") {
    return { status: "ready" };
  }

  const readiness =
    getPluginReadiness(pluginId) ??
    getDurablePluginReadiness(pluginId, pluginDir);
  if (!readiness) {
    return {
      status: "initializing",
      code: "plugin_initializing",
      message: "Plugin is initializing",
    };
  }
  if (readiness.status === "ready") {
    return { status: "ready" };
  }
  return {
    status: readiness.status,
    code:
      readiness.code ??
      (readiness.status === "failed"
        ? "plugin_initialization_failed"
        : readiness.status === "incompatible"
          ? "plugin_incompatible"
          : "plugin_initializing"),
    message:
      readiness.message ??
      (readiness.status === "initializing"
        ? "Plugin is initializing"
        : "Plugin is unavailable"),
  };
}

function getDurablePluginReadiness(
  pluginId: string,
  pluginDir: string,
): PluginReadinessEntry | undefined {
  if (!durableReadsEnabled) {
    return undefined;
  }
  const readiness = readPluginReadinessSnapshot()?.plugins[pluginId];
  if (!readiness) {
    return undefined;
  }
  const now = Date.now();
  const cached = sourceFingerprintCache.get(pluginDir);
  let sourceFingerprint: string;
  if (cached && now - cached.checkedAt < SOURCE_FINGERPRINT_CACHE_MS) {
    sourceFingerprint = cached.fingerprint;
  } else {
    sourceFingerprint = derivePluginSourceFingerprint(
      snapshotPluginSource(pluginDir).fingerprint,
    );
    sourceFingerprintCache.set(pluginDir, {
      checkedAt: now,
      fingerprint: sourceFingerprint,
    });
  }
  return readiness.sourceFingerprint === sourceFingerprint
    ? readiness
    : undefined;
}

export function isPluginSurfaceReady(
  pluginId: string,
  pluginDir: string,
): boolean {
  return getPluginSurfaceActivation(pluginId, pluginDir).status === "ready";
}

function readPluginReadinessSnapshot(
  workspaceDir = getWorkspaceDir(),
): PluginReadinessSnapshot | undefined {
  const path = getPluginReadinessPath(workspaceDir);
  const signature = getFileSignature(path);
  if (
    durableSnapshotCache?.path === path &&
    durableSnapshotCache.signature === signature
  ) {
    return durableSnapshotCache.value;
  }
  let value: PluginReadinessSnapshot | undefined;
  try {
    value = existsSync(path)
      ? PluginReadinessSnapshotSchema.parse(
          JSON.parse(readFileSync(path, "utf8")),
        )
      : undefined;
  } catch {
    value = undefined;
  }
  durableSnapshotCache = { path, signature, value };
  return value;
}

export function resetPluginReadinessForTests(
  options: { readonly durableReads?: boolean } = {},
): void {
  snapshot = createSnapshot();
  durableReadsEnabled = options.durableReads ?? false;
  durableSnapshotCache = undefined;
  sourceFingerprintCache.clear();
}
