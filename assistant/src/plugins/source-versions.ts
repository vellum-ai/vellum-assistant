/**
 * The plugin source-versions sentinel — the broadcast contract between the
 * resource monitor's source watcher (the single writer, running in its own
 * OS process) and every process that holds plugin code in a module registry
 * (the readers: the daemon, platform workers, plugin-spawned workers).
 *
 * The watcher rewrites the document atomically (temp + rename) and only when
 * plugin source actually changed, so "the sentinel's mtime moved" is exactly
 * the signal "some plugin's source is different". A reader keeps the last
 * document it saw, stats this one file on its own cadence (constant cost,
 * independent of plugin count and size), and on change diffs per-directory
 * fingerprints to learn *which* plugins changed and *which* module paths to
 * evict from its own registry — no walking, no registry enumeration.
 *
 * Readers must diff `plugins` fingerprints, never `generation`: generation
 * is per-writer-lifetime bookkeeping, and a watcher restart that observes
 * identical source adopts the existing document without rewriting, so
 * fingerprint diffs stay idempotent across restarts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  PLUGIN_SOURCE_VERSIONS_FILENAME,
  PLUGIN_SOURCE_VERSIONS_FORMAT,
  type PluginSourceVersion,
  type PluginSourceVersionsSnapshot,
  PluginSourceVersionsSnapshotSchema,
} from "@vellumai/service-contracts/plugin-readiness";

import { getMonitoringDataDir } from "../util/platform.js";

/**
 * Sentinel filename, under the monitoring data directory
 * (`<workspace>/data/monitoring/`). That home is deliberate: it is
 * runtime-owned state the monitor already writes to, and it sits inside the
 * workspace git-service ignore rules — the document carries absolute
 * host-specific paths that must never be committed into workspace history.
 */
export const SOURCE_VERSIONS_FILENAME = PLUGIN_SOURCE_VERSIONS_FILENAME;

/** Document format version; readers ignore documents from a different format. */
export const SOURCE_VERSIONS_FORMAT = PLUGIN_SOURCE_VERSIONS_FORMAT;

/**
 * One watched directory's source state: a plugin directory, or the
 * standalone workspace hooks directory.
 */
export type { PluginSourceVersion };

/** The on-disk sentinel document. */
export type SourceVersionsDocument = PluginSourceVersionsSnapshot;

/** Absolute path of the sentinel document. */
export function getSourceVersionsPath(): string {
  return join(getMonitoringDataDir(), SOURCE_VERSIONS_FILENAME);
}

/**
 * Read and minimally validate the sentinel. Returns `null` when the file is
 * missing, unparseable, or from a different format version — readers treat
 * all three as "no live-reload signal available" and keep their last state.
 */
export function readSourceVersions(): SourceVersionsDocument | null {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(getSourceVersionsPath(), "utf8"),
    );
    const parsed = PluginSourceVersionsSnapshotSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
