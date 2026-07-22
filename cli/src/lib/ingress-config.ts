import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  lookupAssistantByIdentifier,
  saveAssistantEntry,
} from "./assistant-config.js";

/**
 * Shared workspace-config helpers for tunnel providers (ngrok, cloudflare,
 * tailscale) and the nginx ingress proxy. Each provider fronts the local edge
 * and records the resulting public URL under `ingress.publicBaseUrl` so webhook
 * integrations can reach the assistant. The workspace config is the
 * gateway-facing contract; when an `assistantId` is supplied, the URL is also
 * mirrored onto the lockfile entry (`ingressUrl`) — the CLI-owned contract
 * that CLI features (e.g. remote-web pairing defaults) read, per the
 * no-`.vellum/`-reads boundary in cli/AGENTS.md.
 */

/** Default workspace dir: `$VELLUM_WORKSPACE_DIR` or `~/.vellum/workspace`. */
export function getDefaultWorkspaceDir(): string {
  return (
    process.env.VELLUM_WORKSPACE_DIR?.trim() ||
    join(homedir(), ".vellum", "workspace")
  );
}

function getConfigPath(workspaceDir: string): string {
  return join(workspaceDir, "config.json");
}

/** Read the workspace `config.json`, or an empty object when it is absent. */
export function loadRawConfig(workspaceDir: string): Record<string, unknown> {
  const configPath = getConfigPath(workspaceDir);
  if (!existsSync(configPath)) return {};
  return JSON.parse(readFileSync(configPath, "utf-8")) as Record<
    string,
    unknown
  >;
}

/** Write the workspace `config.json`, creating parent directories as needed. */
export function saveRawConfig(
  workspaceDir: string,
  config: Record<string, unknown>,
): void {
  const configPath = getConfigPath(workspaceDir);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

/** Mirror the ingress URL onto the lockfile entry; null removes it. */
function stampLockfileIngressUrl(
  assistantId: string,
  publicUrl: string | null,
): void {
  const result = lookupAssistantByIdentifier(assistantId);
  if (result.status !== "found") {
    return;
  }
  const entry = result.entry;
  if (publicUrl) {
    entry.ingressUrl = publicUrl;
  } else {
    delete entry.ingressUrl;
  }
  saveAssistantEntry(entry);
}

/** Persist a public ingress URL to the workspace config and enable ingress. */
export function saveIngressUrl(
  workspaceDir: string,
  publicUrl: string,
  assistantId?: string,
): void {
  const config = loadRawConfig(workspaceDir);
  const ingress = (config.ingress ?? {}) as Record<string, unknown>;
  ingress.publicBaseUrl = publicUrl;
  ingress.enabled = true;
  config.ingress = ingress;
  saveRawConfig(workspaceDir, config);
  if (assistantId) {
    stampLockfileIngressUrl(assistantId, publicUrl);
  }
}

/** Clear the ingress public base URL from the workspace config. */
export function clearIngressUrl(
  workspaceDir: string,
  assistantId?: string,
): void {
  const config = loadRawConfig(workspaceDir);
  const ingress = (config.ingress ?? {}) as Record<string, unknown>;
  delete ingress.publicBaseUrl;
  config.ingress = ingress;
  saveRawConfig(workspaceDir, config);
  if (assistantId) {
    stampLockfileIngressUrl(assistantId, null);
  }
}
