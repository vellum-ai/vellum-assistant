import { homedir } from "node:os";
import { join } from "node:path";

export type AssistantConnectionMode = "cloud" | "local";

const DEFAULT_CONNECTION_MODE: AssistantConnectionMode = "cloud";

function normalizeConnectionMode(
  rawMode: string | undefined
): AssistantConnectionMode {
  const normalized = rawMode?.trim().toLowerCase();
  if (normalized === "local") {
    return "local";
  }
  return DEFAULT_CONNECTION_MODE;
}

function expandHomePath(pathValue: string): string {
  if (pathValue === "~") {
    return homedir();
  }
  if (pathValue.startsWith("~/")) {
    return join(homedir(), pathValue.slice(2));
  }
  return pathValue;
}

export function getAssistantConnectionMode(): AssistantConnectionMode {
  return normalizeConnectionMode(process.env.ASSISTANT_CONNECTION_MODE);
}

export function isLocalDaemonMode(): boolean {
  return getAssistantConnectionMode() === "local";
}

export function getLocalDaemonSocketPath(): string {
  const configuredPath = process.env.LOCAL_DAEMON_SOCKET_PATH?.trim();
  if (!configuredPath) {
    return join(homedir(), ".vellum", "vellum.sock");
  }
  return expandHomePath(configuredPath);
}
