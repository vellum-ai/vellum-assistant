import { z } from 'zod';
import { emptyDefault } from './schema-utils.js';

export const SkillEntryConfigSchema = z.object({
  enabled: z.boolean({ error: 'skills.entries[].enabled must be a boolean' }).default(true),
  apiKey: z.string({ error: 'skills.entries[].apiKey must be a string' }).optional(),
  env: z.record(z.string(), z.string({ error: 'skills.entries[].env values must be strings' })).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const SkillsLoadConfigSchema = z.object({
  extraDirs: z.array(z.string({ error: 'skills.load.extraDirs values must be strings' })).default([]),
  watch: z.boolean({ error: 'skills.load.watch must be a boolean' }).default(true),
  watchDebounceMs: z.number({ error: 'skills.load.watchDebounceMs must be a number' }).int().positive().default(250),
});

export const SkillsInstallConfigSchema = z.object({
  nodeManager: z.enum(['npm', 'pnpm', 'yarn', 'bun'], {
    error: 'skills.install.nodeManager must be one of: npm, pnpm, yarn, bun',
  }).default('npm'),
});

export const SkillsConfigSchema = z.object({
  entries: z.record(z.string(), SkillEntryConfigSchema).default({}),
  load: emptyDefault(SkillsLoadConfigSchema),
  install: emptyDefault(SkillsInstallConfigSchema),
  allowBundled: z.array(z.string()).nullable().default(null),
});

export type SkillEntryConfig = z.infer<typeof SkillEntryConfigSchema>;
export type SkillsLoadConfig = z.infer<typeof SkillsLoadConfigSchema>;
export type SkillsInstallConfig = z.infer<typeof SkillsInstallConfigSchema>;
export type SkillsConfig = z.infer<typeof SkillsConfigSchema>;
