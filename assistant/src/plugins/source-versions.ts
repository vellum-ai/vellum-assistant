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

import { getMonitoringDataDir } from "../util/platform.js";

/**
 * Sentinel filename, under the monitoring data directory
 * (`<workspace>/data/monitoring/`). That home is deliberate: it is
 * runtime-owned state the monitor already writes to, and it sits inside the
 * workspace git-service ignore rules — the document carries absolute
 * host-specific paths that must never be committed into workspace history.
 */
export const SOURCE_VERSIONS_FILENAME = "plugin-source-versions.json";

/** Document format version; readers ignore documents from a different format. */
export const SOURCE_VERSIONS_FORMAT = 1;

/**
 * One watched directory's source state: a plugin directory, or the
 * standalone workspace hooks directory.
 */
export interface PluginSourceVersion {
  /**
   * Opaque stamp over the directory's source files (see
   * `./source-fingerprint.ts`). Changes iff a source file was edited,
   * added, removed, or renamed.
   */
  readonly fingerprint: string;
  /**
   * Absolute module paths a reader must evict from its module registry when
   * this fingerprint changes — the realpath of every source file, plus
   * symlink-rooted aliases when the directory is reached through a symlink.
   * Eviction cost scales with the plugin, not with the reader's whole
   * module graph.
   */
  readonly evictionPaths: readonly string[];
  /** Whether a `.disabled` sentinel is present. Dotfiles are excluded from
   * the fingerprint, so this surfaces disable/enable transitions. */
  readonly disabled: boolean;
}

/** The on-disk sentinel document. */
export interface SourceVersionsDocument {
  readonly format: number;
  /** Increments on every rewrite within one watcher lifetime. Bookkeeping
   * only — readers diff fingerprints, not this. */
  readonly generation: number;
  /** ISO timestamp of the last rewrite, for staleness logging. */
  readonly writtenAt: string;
  /**
   * Keyed by the absolute directory path as the platform helpers construct
   * it (`getWorkspacePluginsDir()`-derived plugin dirs, plus
   * `getWorkspaceHooksDir()` for standalone workspace hooks), so readers
   * can key their own state the same way without any name resolution.
   */
  readonly plugins: Readonly<Record<string, PluginSourceVersion>>;
}

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
    if (typeof raw !== "object" || raw === null) {
      return null;
    }
    const doc = raw as SourceVersionsDocument;
    if (doc.format !== SOURCE_VERSIONS_FORMAT) {
      return null;
    }
    if (typeof doc.plugins !== "object" || doc.plugins === null) {
      return null;
    }
    return doc;
  } catch {
    return null;
  }
}
