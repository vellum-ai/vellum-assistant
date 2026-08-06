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

/** Update the `ingress.ngrok` entry in place, dropping it when it empties. */
function updateNgrokEntry(
  workspaceDir: string,
  mutate: (ngrok: Record<string, unknown>) => void,
): void {
  const config = loadRawConfig(workspaceDir);
  const ingress = (config.ingress ?? {}) as Record<string, unknown>;
  const ngrok = (ingress.ngrok ?? {}) as Record<string, unknown>;
  mutate(ngrok);
  if (Object.keys(ngrok).length > 0) {
    ingress.ngrok = ngrok;
  } else {
    delete ingress.ngrok;
  }
  config.ingress = ingress;
  saveRawConfig(workspaceDir, config);
}

/** Persist a reserved ngrok domain under `ingress.ngrok.domain`; null clears it. */
export function saveNgrokDomain(
  workspaceDir: string,
  domain: string | null,
): void {
  updateNgrokEntry(workspaceDir, (ngrok) => {
    if (domain) {
      ngrok.domain = domain;
    } else {
      delete ngrok.domain;
    }
  });
}

/** Read the reserved ngrok domain from the workspace config, if saved. */
export function loadNgrokDomain(workspaceDir: string): string | null {
  const config = loadRawConfig(workspaceDir);
  const ingress = config.ingress as Record<string, unknown> | undefined;
  const ngrok = ingress?.ngrok as Record<string, unknown> | undefined;
  const domain = ngrok?.domain;
  return typeof domain === "string" && domain.trim() ? domain : null;
}

/** Persisted record of the vellum-spawned dedicated ngrok agent. */
export interface NgrokAgentRecord {
  /** The agent's dedicated web-addr (local API) port. */
  webAddrPort: number;
  /** The agent's process id, when the spawning run recorded one. */
  pid: number | null;
}

/**
 * Persist the spawned ngrok agent's dedicated web-addr port and pid under
 * `ingress.ngrok` so later runs can query that agent's local API and reuse
 * its tunnel, or stop the agent when it no longer serves the requested
 * target; null clears a stale record.
 */
export function saveNgrokAgent(
  workspaceDir: string,
  agent: { webAddrPort: number; pid?: number | null } | null,
): void {
  updateNgrokEntry(workspaceDir, (ngrok) => {
    if (agent !== null) {
      ngrok.webAddrPort = agent.webAddrPort;
      if (agent.pid !== undefined && agent.pid !== null) {
        ngrok.agentPid = agent.pid;
      } else {
        delete ngrok.agentPid;
      }
    } else {
      delete ngrok.webAddrPort;
      delete ngrok.agentPid;
    }
  });
}

/** Read the persisted dedicated-agent record, if saved. */
export function loadNgrokAgent(workspaceDir: string): NgrokAgentRecord | null {
  const config = loadRawConfig(workspaceDir);
  const ingress = config.ingress as Record<string, unknown> | undefined;
  const ngrok = ingress?.ngrok as Record<string, unknown> | undefined;
  const port = ngrok?.webAddrPort;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) {
    return null;
  }
  const pid = ngrok?.agentPid;
  const validPid =
    typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
  return { webAddrPort: port, pid: validPid };
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
