/**
 * Stable per-install client identity for the CLI.
 *
 * Generates a UUID on first use and persists it to
 * `~/.config/vellum/client-id` so the daemon's event hub can
 * track this terminal across SSE reconnects and CLI restarts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { homedir } from "os";
import { join } from "path";

export const CLI_INTERFACE_ID = "cli";

let cached: string | null = null;

function getConfigDir(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "vellum");
}

/**
 * Returns a stable UUID identifying this CLI installation.
 * Generated once and persisted to `~/.config/vellum/client-id`.
 */
export function getClientId(): string {
  if (cached) return cached;

  const configDir = getConfigDir();
  const idFile = join(configDir, "client-id");

  try {
    if (existsSync(idFile)) {
      const stored = readFileSync(idFile, "utf-8").trim();
      if (stored) {
        cached = stored;
        return stored;
      }
    }
  } catch {
    /* best-effort read */
  }

  const id = randomUUID();
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(idFile, id, "utf-8");
  } catch {
    /* best-effort persist — transient id still works for this session */
  }

  cached = id;
  return id;
}

/**
 * Headers that identify this CLI client to the assistant daemon.
 * Attach to all requests so the ClientRegistry can track connected
 * clients and their capabilities.
 *
 * @param interfaceId - Override the interface ID (default: "cli").
 */
export function getClientRegistrationHeaders(
  interfaceId: string = CLI_INTERFACE_ID,
): Record<string, string> {
  return {
    "X-Vellum-Client-Id": getClientId(),
    "X-Vellum-Interface-Id": interfaceId,
  };
}
