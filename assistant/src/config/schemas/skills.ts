import { z } from "zod";

export const SkillEntryConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "skills.entries[].enabled must be a boolean" })
      .default(true)
      .describe("Whether this skill is enabled"),
    apiKey: z
      .string({ error: "skills.entries[].apiKey must be a string" })
      .optional()
      .describe("API key for authenticated skill access"),
    env: z
      .record(
        z.string(),
        z.string({ error: "skills.entries[].env values must be strings" }),
      )
      .optional()
      .describe("Environment variables passed to the skill"),
    config: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Arbitrary key-value configuration passed to the skill"),
  })
  .describe("Configuration for an individual skill");

const SkillsLoadConfigSchema = z
  .object({
    extraDirs: z
      .array(
        z.string({ error: "skills.load.extraDirs values must be strings" }),
      )
      .default([])
      .describe("Additional directories to search for skill definitions"),
    watch: z
      .boolean({ error: "skills.load.watch must be a boolean" })
      .default(true)
      .describe(
        "Whether to watch skill directories for changes and auto-reload",
      ),
    watchDebounceMs: z
      .number({ error: "skills.load.watchDebounceMs must be a number" })
      .int()
      .positive()
      .default(250)
      .describe(
        "Debounce delay in milliseconds for skill file change detection",
      ),
  })
  .describe("Controls how skills are discovered and loaded");

const SkillsInstallConfigSchema = z
  .object({
    nodeManager: z
      .enum(["npm", "pnpm", "yarn", "bun"], {
        error:
          "skills.install.nodeManager must be one of: npm, pnpm, yarn, bun",
      })
      .default("npm")
      .describe("Node package manager used to install skill dependencies"),
  })
  .describe("Skill dependency installation settings");

const RemoteProviderConfigSchema = z
  .object({
    enabled: z
      .boolean({
        error: "skills.remoteProviders.<provider>.enabled must be a boolean",
      })
      .default(true)
      .describe("Whether this remote skill provider is enabled"),
  })
  .describe("Configuration for a remote skill provider");

const RemoteProvidersConfigSchema = z
  .object({
    skillssh: RemoteProviderConfigSchema.default(
      RemoteProviderConfigSchema.parse({}),
    ).describe("skills.sh remote skill provider"),
    clawhub: RemoteProviderConfigSchema.default(
      RemoteProviderConfigSchema.parse({}),
    ).describe("ClawHub remote skill provider"),
  })
  .describe("Remote skill provider configurations");

// 'unknown' is valid as a risk label on a skill but not as a threshold — setting the threshold
// to 'unknown' would silently disable fail-closed behavior since nothing can exceed it.
const VALID_MAX_RISK_LEVELS = [
  "safe",
  "low",
  "medium",
  "high",
  "critical",
] as const;

const RemotePolicyConfigSchema = z
  .object({
    blockSuspicious: z
      .boolean({
        error: "skills.remotePolicy.blockSuspicious must be a boolean",
      })
      .default(true)
      .describe("Whether to block skills flagged as suspicious"),
    blockMalware: z
      .boolean({ error: "skills.remotePolicy.blockMalware must be a boolean" })
      .default(true)
      .describe("Whether to block skills flagged as malware"),
    maxSkillsShRisk: z
      .enum(VALID_MAX_RISK_LEVELS, {
        error: `skills.remotePolicy.maxSkillsShRisk must be one of: ${VALID_MAX_RISK_LEVELS.join(
          ", ",
        )}`,
      })
      .default("medium")
      .describe(
        "Maximum risk level accepted from skills.sh — skills above this level are blocked",
      ),
  })
  .describe(
    "Security policy for remote skills — controls what risk levels are allowed",
  );

export const SkillsConfigSchema = z
  .object({
    entries: z
      .record(z.string(), SkillEntryConfigSchema)
      .default({} as Record<string, never>)
      .describe("Map of skill names to their per-skill configuration"),
    load: SkillsLoadConfigSchema.default(SkillsLoadConfigSchema.parse({})),
    install: SkillsInstallConfigSchema.default(
      SkillsInstallConfigSchema.parse({}),
    ),
    allowBundled: z
      .array(z.string())
      .nullable()
      .default(null)
      .describe(
        "Allowlist of bundled skill names to load (null = load all bundled skills)",
      ),
    remoteProviders: RemoteProvidersConfigSchema.default(
      RemoteProvidersConfigSchema.parse({}),
    ),
    remotePolicy: RemotePolicyConfigSchema.default(
      RemotePolicyConfigSchema.parse({}),
    ),
  })
  .describe(
    "Skill system configuration — loading, installation, and remote providers",
  );

export type SkillEntryConfig = z.infer<typeof SkillEntryConfigSchema>;
