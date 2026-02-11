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

export function getAssistantConnectionMode(): AssistantConnectionMode {
  return normalizeConnectionMode(process.env.ASSISTANT_CONNECTION_MODE);
}

export function isLocalDaemonMode(): boolean {
  return getAssistantConnectionMode() === "local";
}
