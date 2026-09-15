/**
 * Resolve the manifest that identifies an installed plugin.
 *
 * `package.json` remains the compatibility manifest for existing Vellum
 * plugins. A root `plugin.json` is selected only when `package.json` is absent,
 * which lets standard Agent Plugins load without reclassifying legacy installs
 * that happen to carry another ecosystem's `plugin.json`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

export const LEGACY_PLUGIN_MANIFEST = "package.json";
export const STANDARD_PLUGIN_MANIFEST = "plugin.json";
export const AGENT_PLUGINS_MANIFEST_SCHEMA_URL =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

const PluginNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?!.*(?:--|\.\.))[a-z0-9.-]*[a-z0-9]$|^[a-z0-9]$/);

const LegacyPluginManifestSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().optional(),
    description: z.string().min(1).optional(),
    homepage: z.string().optional(),
    license: z.unknown().optional(),
    peerDependencies: z.record(z.string(), z.string()).optional(),
    credentialKeyPatterns: z.unknown().optional(),
    displayName: z.string().min(1).optional(),
    icon: z.string().min(1).optional(),
  })
  .passthrough();

const StandardPluginManifestSchema = z
  .object({
    $schema: z.literal(AGENT_PLUGINS_MANIFEST_SCHEMA_URL),
    name: PluginNameSchema,
    version: z.string().optional(),
    description: z.string().optional(),
    author: z
      .object({
        name: z.string().optional(),
        email: z.string().optional(),
        url: z.string().optional(),
      })
      .strict()
      .optional(),
    homepage: z.string().optional(),
    repository: z.string().optional(),
    license: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    // The core specification says a non-object extensions value is reported
    // and ignored rather than rejecting the plugin. This host does not consume
    // a standard extension namespace here, so keep it opaque.
    extensions: z.unknown().optional(),
  })
  // Unknown core fields are reported-and-ignored by the specification. The
  // loader does not assign them semantics, so passthrough preserves that
  // non-fatal behavior without copying them into runtime metadata.
  .passthrough();

export type PluginManifestSource =
  | typeof LEGACY_PLUGIN_MANIFEST
  | typeof STANDARD_PLUGIN_MANIFEST;

export interface ResolvedPluginManifest {
  readonly source: PluginManifestSource;
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly homepage?: string;
  readonly license?: unknown;
  /** Parsed selected manifest, retained for Vellum-specific legacy fields. */
  readonly raw: Record<string, unknown>;
}

export class PluginManifestError extends Error {
  constructor(
    readonly pluginDir: string,
    readonly source: PluginManifestSource | null,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PluginManifestError";
  }
}

/** True when the directory carries either supported root manifest. */
export function hasPluginManifest(pluginDir: string): boolean {
  return (
    existsSync(join(pluginDir, LEGACY_PLUGIN_MANIFEST)) ||
    existsSync(join(pluginDir, STANDARD_PLUGIN_MANIFEST))
  );
}

/**
 * Read and validate the selected root manifest.
 *
 * Selection is deterministic and backwards compatible: `package.json` wins
 * when present, including when it is malformed. The loader never falls through
 * from a selected malformed legacy manifest to `plugin.json`.
 */
export function readPluginManifest(pluginDir: string): ResolvedPluginManifest {
  const source = existsSync(join(pluginDir, LEGACY_PLUGIN_MANIFEST))
    ? LEGACY_PLUGIN_MANIFEST
    : existsSync(join(pluginDir, STANDARD_PLUGIN_MANIFEST))
      ? STANDARD_PLUGIN_MANIFEST
      : null;
  if (source === null) {
    throw new PluginManifestError(
      pluginDir,
      null,
      `plugin at ${pluginDir} is missing package.json and plugin.json`,
    );
  }

  const path = join(pluginDir, source);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new PluginManifestError(
      pluginDir,
      source,
      `${source} at ${pluginDir} could not be read or parsed: ${reason}`,
      cause,
    );
  }

  const parsed =
    source === LEGACY_PLUGIN_MANIFEST
      ? LegacyPluginManifestSchema.safeParse(json)
      : StandardPluginManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new PluginManifestError(
      pluginDir,
      source,
      `${source} at ${pluginDir} failed schema validation: ${parsed.error.message}`,
      parsed.error,
    );
  }

  return {
    source,
    name: parsed.data.name,
    version: parsed.data.version,
    description: parsed.data.description,
    homepage: parsed.data.homepage,
    license: parsed.data.license,
    raw: parsed.data,
  };
}
