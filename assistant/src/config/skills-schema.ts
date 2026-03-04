import { z } from "zod";

export const SkillEntryConfigSchema = z.object({
  enabled: z
    .boolean({ error: "skills.entries[].enabled must be a boolean" })
    .default(true),
  apiKey: z
    .string({ error: "skills.entries[].apiKey must be a string" })
    .optional(),
  env: z
    .record(
      z.string(),
      z.string({ error: "skills.entries[].env values must be strings" }),
    )
    .optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const SkillsLoadConfigSchema = z.object({
  extraDirs: z
    .array(z.string({ error: "skills.load.extraDirs values must be strings" }))
    .default([]),
  watch: z
    .boolean({ error: "skills.load.watch must be a boolean" })
    .default(true),
  watchDebounceMs: z
    .number({ error: "skills.load.watchDebounceMs must be a number" })
    .int()
    .positive()
    .default(250),
});

export const SkillsInstallConfigSchema = z.object({
  nodeManager: z
    .enum(["npm", "pnpm", "yarn", "bun"], {
      error: "skills.install.nodeManager must be one of: npm, pnpm, yarn, bun",
    })
    .default("npm"),
});

export const RemoteProviderConfigSchema = z.object({
  enabled: z
    .boolean({
      error: "skills.remoteProviders.<provider>.enabled must be a boolean",
    })
    .default(true),
});

export const RemoteProvidersConfigSchema = z.object({
  skillssh: RemoteProviderConfigSchema.default(
    RemoteProviderConfigSchema.parse({}),
  ),
  clawhub: RemoteProviderConfigSchema.default(
    RemoteProviderConfigSchema.parse({}),
  ),
});

// 'unknown' is valid as a risk label on a skill but not as a threshold — setting the threshold
// to 'unknown' would silently disable fail-closed behavior since nothing can exceed it.
const VALID_MAX_RISK_LEVELS = [
  "safe",
  "low",
  "medium",
  "high",
  "critical",
] as const;

export const RemotePolicyConfigSchema = z.object({
  blockSuspicious: z
    .boolean({ error: "skills.remotePolicy.blockSuspicious must be a boolean" })
    .default(true),
  blockMalware: z
    .boolean({ error: "skills.remotePolicy.blockMalware must be a boolean" })
    .default(true),
  maxSkillsShRisk: z
    .enum(VALID_MAX_RISK_LEVELS, {
      error: `skills.remotePolicy.maxSkillsShRisk must be one of: ${VALID_MAX_RISK_LEVELS.join(
        ", ",
      )}`,
    })
    .default("medium"),
});

export const SkillsConfigSchema = z.object({
  entries: z
    .record(z.string(), SkillEntryConfigSchema)
    .default({} as Record<string, never>),
  load: SkillsLoadConfigSchema.default(SkillsLoadConfigSchema.parse({})),
  install: SkillsInstallConfigSchema.default(
    SkillsInstallConfigSchema.parse({}),
  ),
  allowBundled: z.array(z.string()).nullable().default(null),
  remoteProviders: RemoteProvidersConfigSchema.default(
    RemoteProvidersConfigSchema.parse({}),
  ),
  remotePolicy: RemotePolicyConfigSchema.default(
    RemotePolicyConfigSchema.parse({}),
  ),
});

export type SkillEntryConfig = z.infer<typeof SkillEntryConfigSchema>;
export type SkillsLoadConfig = z.infer<typeof SkillsLoadConfigSchema>;
export type SkillsInstallConfig = z.infer<typeof SkillsInstallConfigSchema>;
export type RemoteProviderConfig = z.infer<typeof RemoteProviderConfigSchema>;
export type RemoteProvidersConfig = z.infer<typeof RemoteProvidersConfigSchema>;
export type RemotePolicyConfig = z.infer<typeof RemotePolicyConfigSchema>;
export type SkillsConfig = z.infer<typeof SkillsConfigSchema>;
