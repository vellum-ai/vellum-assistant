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

const PRODUCTION_APP_URL = "https://www.vellum.ai";

export function isNonProductionEnvironment(): boolean {
  const appUrl = process.env.APP_URL ?? "";
  return appUrl !== PRODUCTION_APP_URL;
}

/**
 * Email root domain for the current environment. Mirrors the per-env
 * `mailgun_email_domain` in `terraform/gcp/env/.../main.tf` so the suffix
 * shown next to the subdomain input matches the address the backend
 * actually provisions.
 */
export function getEmailRootDomain(): string {
  switch (process.env.VELLUM_ENVIRONMENT) {
    case "staging":
      return "staging.vellum.me";
    case "dev":
      return "dev.vellum.me";
    case "local":
      return "local.vellum.me";
    default:
      return "vellum.me";
  }
}
