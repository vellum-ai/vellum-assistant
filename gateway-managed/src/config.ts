export type ManagedGatewayConfig = {
  port: number;
  enabled: boolean;
  serviceName: string;
  mode: string;
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

  return {
    port,
    enabled: parseBoolean(env.MANAGED_GATEWAY_ENABLED, true),
    serviceName: env.MANAGED_GATEWAY_SERVICE_NAME || "managed-gateway",
    mode: env.MANAGED_GATEWAY_MODE || "skeleton",
  };
}
