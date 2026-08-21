import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  INGRESS_ASSISTANT_ID_KEY,
  INGRESS_LAST_TUNNEL_KEY,
  type LastTunnelRecord,
  TUNNEL_PROVIDERS,
  type TunnelProviderName,
} from "@vellumai/service-contracts/ingress";

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

// The tunnel-record contract (provider registry, record shape, key names) is
// shared with the daemon, which reads what this module writes.
export { TUNNEL_PROVIDERS, type TunnelProviderName };

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

function loadIngressSection(
  workspaceDir: string,
): Record<string, unknown> | undefined {
  return loadRawConfig(workspaceDir).ingress as
    | Record<string, unknown>
    | undefined;
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

/**
 * Persist a public ingress URL to the workspace config and enable ingress.
 * `provider`/`assistantId` also land under `ingress.lastTunnel` and
 * `ingress.assistantId`: workspace-only records the daemon reads to report
 * tunnel health, deliberately not mirrored onto the lockfile.
 */
export function saveIngressUrl(
  workspaceDir: string,
  publicUrl: string,
  assistantId?: string,
  provider?: TunnelProviderName,
): void {
  const config = loadRawConfig(workspaceDir);
  const ingress = (config.ingress ?? {}) as Record<string, unknown>;
  ingress.publicBaseUrl = publicUrl;
  ingress.enabled = true;
  if (provider) {
    ingress[INGRESS_LAST_TUNNEL_KEY] = {
      provider,
      publicBaseUrl: publicUrl,
    } satisfies LastTunnelRecord;
  }
  // The daemon can't derive this: it uses 'self' internally.
  if (assistantId) {
    ingress[INGRESS_ASSISTANT_ID_KEY] = assistantId;
  }
  config.ingress = ingress;
  saveRawConfig(workspaceDir, config);
  if (assistantId) {
    stampLockfileIngressUrl(assistantId, publicUrl);
  }
}

/** Persist a reserved ngrok domain under `ingress.ngrok.domain`; null clears it. */
export function saveNgrokDomain(
  workspaceDir: string,
  domain: string | null,
): void {
  const config = loadRawConfig(workspaceDir);
  const ingress = (config.ingress ?? {}) as Record<string, unknown>;
  if (domain) {
    ingress.ngrok = { domain };
  } else {
    delete ingress.ngrok;
  }
  config.ingress = ingress;
  saveRawConfig(workspaceDir, config);
}

/** Read the reserved ngrok domain from the workspace config, if saved. */
export function loadNgrokDomain(workspaceDir: string): string | null {
  const ngrok = loadIngressSection(workspaceDir)?.ngrok as
    | Record<string, unknown>
    | undefined;
  const domain = ngrok?.domain;
  return typeof domain === "string" && domain.trim() ? domain : null;
}

/** Clear the ingress public base URL from the workspace config. */
export function clearIngressUrl(
  workspaceDir: string,
  assistantId?: string,
): void {
  const config = loadRawConfig(workspaceDir);
  const ingress = (config.ingress ?? {}) as Record<string, unknown>;
  // `lastTunnel`/`assistantId` survive teardown on purpose: readers name the
  // tunnel to restart once it is gone.
  delete ingress.publicBaseUrl;
  config.ingress = ingress;
  saveRawConfig(workspaceDir, config);
  if (assistantId) {
    stampLockfileIngressUrl(assistantId, null);
  }
}
