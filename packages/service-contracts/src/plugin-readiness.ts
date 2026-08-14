import { z } from "zod";

export const PLUGIN_READINESS_FILENAME = "plugin-readiness-v1.json";
export const PLUGIN_HOST_REQUIREMENTS_FILENAME = "host-requirements.json";
export const PLUGIN_SOURCE_VERSIONS_FILENAME = "plugin-source-versions.json";
export const PLUGIN_SOURCE_VERSIONS_FORMAT = 2;

export const PluginReadinessStatusSchema = z.enum([
  "initializing",
  "ready",
  "incompatible",
  "failed",
]);

export const PluginReadinessEntrySchema = z
  .object({
    pluginId: z.string().min(1),
    sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    status: PluginReadinessStatusSchema,
    code: z.string().min(1).optional(),
    message: z.string().min(1).optional(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const PluginReadinessSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    generation: z.string().uuid(),
    plugins: z.record(z.string(), PluginReadinessEntrySchema),
  })
  .strict();

export const PluginSourceVersionSchema = z
  .object({
    fingerprint: z.string(),
    sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    evictionPaths: z.array(z.string()),
    disabled: z.boolean(),
  })
  .strict();

export const PluginSourceVersionsSnapshotSchema = z
  .object({
    format: z.literal(PLUGIN_SOURCE_VERSIONS_FORMAT),
    generation: z.number().int().nonnegative(),
    writtenAt: z.string().datetime(),
    plugins: z.record(z.string(), PluginSourceVersionSchema),
  })
  .strict();

export type PluginReadinessStatus = z.infer<
  typeof PluginReadinessStatusSchema
>;
export type PluginReadinessEntry = z.infer<typeof PluginReadinessEntrySchema>;
export type PluginReadinessSnapshot = z.infer<
  typeof PluginReadinessSnapshotSchema
>;
export type PluginSourceVersion = z.infer<typeof PluginSourceVersionSchema>;
export type PluginSourceVersionsSnapshot = z.infer<
  typeof PluginSourceVersionsSnapshotSchema
>;
