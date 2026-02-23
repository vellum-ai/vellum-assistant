/**
 * Email provider registry — resolves provider name to EmailProvider instance.
 *
 * Reads provider config from ~/.vellum/workspace/config.json and API keys
 * from secure storage (via the assistant's secure-keys module when available,
 * falling back to environment variables).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EmailProvider } from "../provider.js";

export const SUPPORTED_PROVIDERS = ["agentmail"] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

const PROVIDER_KEY_MAP: Record<SupportedProvider, string[]> = {
  agentmail: ["agentmail", "credential:agentmail:api_key"],
};

/**
 * Read the active email provider from config.
 * Defaults to 'agentmail' if not set.
 */
export function getActiveProviderName(): SupportedProvider {
  const raw = loadRawConfig();
  const value = getNestedValue(raw, "integrations.email.provider");
  if (
    typeof value === "string" &&
    SUPPORTED_PROVIDERS.includes(value as SupportedProvider)
  ) {
    return value as SupportedProvider;
  }
  return "agentmail";
}

/**
 * Create an EmailProvider instance for the given (or active) provider.
 * Throws if the API key is missing.
 */
export async function createProvider(
  name?: SupportedProvider,
): Promise<EmailProvider> {
  const providerName = name ?? getActiveProviderName();

  switch (providerName) {
    case "agentmail": {
      const candidates = PROVIDER_KEY_MAP.agentmail;
      let apiKey: string | undefined;
      for (const account of candidates) {
        apiKey = getSecureKeyValue(account);
        if (apiKey) break;
      }
      if (!apiKey) {
        throw new Error(
          "No AgentMail API key configured. Run: vellum keys set agentmail <key>",
        );
      }
      const { AgentMailClient } = await import("agentmail");
      const { AgentMailProvider } = await import("./agentmail.js");
      return new AgentMailProvider(new AgentMailClient({ apiKey }));
    }
    default:
      throw new Error(`Unknown email provider: ${providerName}`);
  }
}

// ---------------------------------------------------------------------------
// Minimal config reading — avoids pulling in the full assistant config loader
// ---------------------------------------------------------------------------

function getVellumRoot(): string {
  return join(process.env.BASE_DATA_DIR?.trim() || homedir(), ".vellum");
}

function getWorkspaceConfigPath(): string {
  return join(getVellumRoot(), "workspace", "config.json");
}

export function loadRawConfig(): Record<string, unknown> {
  const configPath = getWorkspaceConfigPath();
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

export function getNestedValue(
  obj: Record<string, unknown>,
  path: string,
): unknown {
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const keys = path.split(".");
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (
      current[key] === undefined ||
      current[key] === null ||
      typeof current[key] !== "object"
    ) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

export function saveRawConfig(config: Record<string, unknown>): void {
  const configPath = getWorkspaceConfigPath();
  const dir = join(getVellumRoot(), "workspace");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Secure key retrieval — tries the assistant's secure-keys module first,
// then falls back to environment variables and config file values.
// ---------------------------------------------------------------------------

const ENV_KEY_MAP: Record<string, string> = {
  agentmail: "AGENTMAIL_API_KEY",
  "credential:agentmail:api_key": "AGENTMAIL_API_KEY",
};

function getSecureKeyValue(account: string): string | undefined {
  // Environment variable lookup
  const envVar = ENV_KEY_MAP[account];
  if (envVar) {
    const value = process.env[envVar];
    if (value) return value;
  }

  // Config file fallback: check apiKeys in config
  const raw = loadRawConfig();
  const apiKeys = raw.apiKeys;
  if (apiKeys && typeof apiKeys === "object" && !Array.isArray(apiKeys)) {
    const value = (apiKeys as Record<string, unknown>)[account];
    if (typeof value === "string" && value.length > 0) return value;
  }

  return undefined;
}
