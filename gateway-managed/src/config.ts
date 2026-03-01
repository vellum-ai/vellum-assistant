export type ManagedGatewayConfig = {
  port: number;
  enabled: boolean;
  serviceName: string;
  mode: string;
  strictStartupValidation: boolean;
  djangoInternalBaseUrl: string | null;
};

function parseBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error("Boolean env values must be true/false.");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ManagedGatewayConfig {
  const rawPort = env.MANAGED_GATEWAY_PORT || "7831";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("MANAGED_GATEWAY_PORT must be a valid port number.");
  }

  const strictStartupValidation = parseBoolean(
    env.MANAGED_GATEWAY_STRICT_STARTUP_VALIDATION,
    true,
  );

  const djangoInternalBaseUrlRaw = env.MANAGED_GATEWAY_DJANGO_INTERNAL_BASE_URL;
  const djangoInternalBaseUrl = djangoInternalBaseUrlRaw?.trim() || null;

  const enabled = parseBoolean(env.MANAGED_GATEWAY_ENABLED, true);
  if (strictStartupValidation && enabled) {
    if (!djangoInternalBaseUrl) {
      throw new Error(
        "MANAGED_GATEWAY_DJANGO_INTERNAL_BASE_URL is required when MANAGED_GATEWAY_ENABLED=true.",
      );
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(djangoInternalBaseUrl);
    } catch {
      throw new Error(
        "MANAGED_GATEWAY_DJANGO_INTERNAL_BASE_URL must be a valid absolute URL.",
      );
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error(
        "MANAGED_GATEWAY_DJANGO_INTERNAL_BASE_URL must use http or https.",
      );
    }
  }

  return {
    port,
    enabled,
    serviceName: env.MANAGED_GATEWAY_SERVICE_NAME || "managed-gateway",
    mode: env.MANAGED_GATEWAY_MODE || "skeleton",
    strictStartupValidation,
    djangoInternalBaseUrl,
  };
}
