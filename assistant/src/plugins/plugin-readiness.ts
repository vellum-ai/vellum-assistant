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
import type { PluginActivationEligibility } from "./activation-eligibility.js";
export { derivePluginSourceFingerprint } from "./source-fingerprint.js";

let snapshot: PluginReadinessSnapshot = createSnapshot();

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

export function readPluginReadinessSnapshot(
  workspaceDir = getWorkspaceDir(),
): PluginReadinessSnapshot | undefined {
  const path = getPluginReadinessPath(workspaceDir);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return PluginReadinessSnapshotSchema.parse(
      JSON.parse(readFileSync(path, "utf8")),
    );
  } catch {
    return undefined;
  }
}

export function resetPluginReadinessForTests(): void {
  snapshot = createSnapshot();
}
