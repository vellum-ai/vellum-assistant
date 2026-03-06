import type { GatewayConfig } from "./config.js";

type ConfigFileMapping =
  | {
      key: string;
      field: string;
      configField: keyof GatewayConfig;
      type: "string";
    }
  | {
      key: string;
      field: string;
      configField: keyof GatewayConfig;
      type: "record";
    };

export const CONFIG_FILE_MAPPINGS: ConfigFileMapping[] = [
  {
    key: "email",
    field: "address",
    configField: "assistantEmail",
    type: "string",
  },
  {
    key: "twilio",
    field: "accountSid",
    configField: "twilioAccountSid",
    type: "string",
  },
  {
    key: "ingress",
    field: "publicBaseUrl",
    configField: "ingressPublicBaseUrl",
    type: "string",
  },
];

function resolveRawValue(mapping: ConfigFileMapping, raw: unknown): unknown {
  switch (mapping.type) {
    case "string":
      return typeof raw === "string" ? raw || undefined : undefined;
    case "record":
      return raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw
        : undefined;
  }
}

export function applyConfigFileMappings(
  data: Record<string, unknown>,
  changedKeys: Set<string>,
  config: GatewayConfig,
): void {
  for (const mapping of CONFIG_FILE_MAPPINGS) {
    if (!changedKeys.has(mapping.key)) continue;
    const section = data[mapping.key] as Record<string, unknown> | undefined;
    const raw = section?.[mapping.field];
    (config as Record<string, unknown>)[mapping.configField] = resolveRawValue(
      mapping,
      raw,
    );
  }
}

export function readConfigFileDefaults(
  data: Record<string, unknown>,
): Partial<Record<keyof GatewayConfig, unknown>> {
  const defaults: Partial<Record<keyof GatewayConfig, unknown>> = {};
  for (const mapping of CONFIG_FILE_MAPPINGS) {
    const section = data[mapping.key] as Record<string, unknown> | undefined;
    const raw = section?.[mapping.field];
    defaults[mapping.configField] = resolveRawValue(mapping, raw);
  }
  return defaults;
}
