import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Shared workspace-config helpers for tunnel providers (ngrok, cloudflare,
 * tailscale) and the nginx ingress proxy. Each provider fronts the local edge
 * and records the resulting public URL under `ingress.publicBaseUrl` so webhook
 * integrations can reach the assistant.
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

/** Persist a public ingress URL to the workspace config and enable ingress. */
export function saveIngressUrl(workspaceDir: string, publicUrl: string): void {
  const config = loadRawConfig(workspaceDir);
  const ingress = (config.ingress ?? {}) as Record<string, unknown>;
  ingress.publicBaseUrl = publicUrl;
  ingress.enabled = true;
  config.ingress = ingress;
  saveRawConfig(workspaceDir, config);
}

/** Clear the ingress public base URL from the workspace config. */
export function clearIngressUrl(workspaceDir: string): void {
  const config = loadRawConfig(workspaceDir);
  const ingress = (config.ingress ?? {}) as Record<string, unknown>;
  delete ingress.publicBaseUrl;
  config.ingress = ingress;
  saveRawConfig(workspaceDir, config);
}
