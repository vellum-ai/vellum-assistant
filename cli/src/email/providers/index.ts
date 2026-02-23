/**
 * Email provider registry — creates the Vellum email provider instance.
 *
 * Reads API key from environment variables or config file.
 * The Vellum platform is the only supported email provider.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EmailProvider } from "../provider.js";
import { VellumProvider } from "./vellum.js";

/**
 * Create the Vellum email provider instance.
 * Throws if the API key is missing.
 */
export async function createProvider(): Promise<EmailProvider> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error(
      "No Vellum API key configured. Set the VELLUM_API_KEY environment variable.",
    );
  }
  const baseUrl = process.env.VELLUM_API_URL ?? "https://api.vellum.ai";
  return new VellumProvider(apiKey, baseUrl);
}

// ---------------------------------------------------------------------------
// Config reading
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
// API key resolution
// ---------------------------------------------------------------------------

function getApiKey(): string | undefined {
  // Environment variable
  const envValue = process.env.VELLUM_API_KEY;
  if (envValue) return envValue;

  // Config file fallback
  const raw = loadRawConfig();
  const apiKeys = raw.apiKeys;
  if (apiKeys && typeof apiKeys === "object" && !Array.isArray(apiKeys)) {
    const value = (apiKeys as Record<string, unknown>)["vellum"];
    if (typeof value === "string" && value.length > 0) return value;
  }

  return undefined;
}
