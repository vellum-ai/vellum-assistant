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
    }
  | {
      key: string;
      field: string;
      configField: keyof GatewayConfig;
      type: "normalized-record";
    };

export const CONFIG_FILE_MAPPINGS: ConfigFileMapping[] = [
  {
    key: "twilio",
    field: "phoneNumber",
    configField: "twilioPhoneNumber",
    type: "string",
  },
  {
    key: "twilio",
    field: "assistantPhoneNumbers",
    configField: "assistantPhoneNumbers",
    type: "normalized-record",
  },
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

/** Iterate entries and keep only those whose value is a non-empty, non-whitespace string. */
function normalizeRecord(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" && v.trim() !== "") {
      result[k] = v;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function resolveRawValue(mapping: ConfigFileMapping, raw: unknown): unknown {
  switch (mapping.type) {
    case "string":
      return typeof raw === "string" ? raw || undefined : undefined;
    case "record":
      return raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw
        : undefined;
    case "normalized-record":
      return normalizeRecord(raw);
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
