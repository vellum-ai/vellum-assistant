/**
 * Write gateway proxy settings to workspace config for local development.
 * Used by the `dev:proxy` npm script.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const rootDir = join(
  process.env.BASE_DATA_DIR?.trim() || (process.env.HOME ?? homedir()),
  ".vellum",
);
const configPath = join(rootDir, "workspace", "config.json");

let config: Record<string, unknown> = {};
try {
  if (existsSync(configPath)) {
    config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<
      string,
      unknown
    >;
  }
} catch {
  // start fresh
}

const gateway = (config.gateway ?? {}) as Record<string, unknown>;
gateway.runtimeProxyEnabled = true;
gateway.runtimeProxyRequireAuth = false;
gateway.unmappedPolicy = "default";
gateway.defaultAssistantId = "self";
config.gateway = gateway;

const dir = dirname(configPath);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

console.log("Gateway proxy settings written to workspace config");
