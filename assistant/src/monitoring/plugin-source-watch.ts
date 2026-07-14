/**
 * Plugin source watcher — the change-detector half of plugin live reload,
 * running inside the resource monitor process.
 *
 * Hook dispatch in the daemon is a hot path (it runs many times per turn),
 * so the daemon must not pay for filesystem walks to learn whether plugin
 * source changed. This watcher does the walking here instead, off every
 * consumer's event loop: on each tick it discovers plugin directories,
 * fingerprints their source (see `../plugins/source-fingerprint.ts`), and —
 * only when something changed — atomically rewrites the source-versions
 * sentinel (see `../plugins/source-versions.ts`). Consumers stat that one
 * file to learn about changes.
 *
 * Polling by stat is deliberate: inotify-style watchers don't reliably see
 * host-side writes on virtualized mounts (virtiofs, 9p), while a stat walk
 * works everywhere the files do. The walk is synchronous, so ticks can't
 * overlap; a pass over 10 plugins × 100 files measures ~3.6ms warm on ext4.
 *
 * A watcher restart observes the existing sentinel and adopts it when the
 * source is unchanged, so restarts never publish spurious change signals.
 * Failures are logged and skipped — the monitor must keep sampling even if
 * a walk trips over a half-written plugin directory.
 */

import {
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { snapshotPluginSource } from "../plugins/source-fingerprint.js";
import type {
  PluginSourceVersion,
  SourceVersionsDocument,
} from "../plugins/source-versions.js";
import {
  getSourceVersionsPath,
  readSourceVersions,
  SOURCE_VERSIONS_FORMAT,
} from "../plugins/source-versions.js";
import { getLogger } from "../util/logger.js";
import {
  getMonitoringDataDir,
  getWorkspaceHooksDir,
  getWorkspacePluginsDir,
} from "../util/platform.js";

const log = getLogger("plugin-source-watch");

/**
 * Collect the current source version of every watched directory: each
 * plugin directory under `<workspace>/plugins/` (same discovery rule as the
 * daemon's plugin scan — a directory with a `package.json`), plus the
 * standalone workspace hooks directory when it exists. Disabled plugins are
 * fingerprinted too: consumers need fresh state the moment a plugin is
 * re-enabled, and the `disabled` field is how they observe the toggle
 * itself (dotfiles are excluded from the fingerprint).
 */
export function collectSourceVersions(): Record<string, PluginSourceVersion> {
  const out: Record<string, PluginSourceVersion> = {};

  const pluginsDir = getWorkspacePluginsDir();
  let entries: string[] = [];
  try {
    entries = readdirSync(pluginsDir);
  } catch {
    // No plugins directory yet — nothing to watch there.
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) {
      continue;
    }
    const dir = join(pluginsDir, entry);
    try {
      if (!statSync(dir).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    if (!existsSync(join(dir, "package.json"))) {
      continue;
    }
    const snapshot = snapshotPluginSource(dir);
    out[dir] = {
      fingerprint: snapshot.fingerprint,
      evictionPaths: snapshot.evictionPaths,
      disabled: existsSync(join(dir, ".disabled")),
    };
  }

  const workspaceHooksDir = getWorkspaceHooksDir();
  if (existsSync(workspaceHooksDir)) {
    const snapshot = snapshotPluginSource(workspaceHooksDir);
    out[workspaceHooksDir] = {
      fingerprint: snapshot.fingerprint,
      evictionPaths: snapshot.evictionPaths,
      disabled: false,
    };
  }

  return out;
}

/**
 * Whether two version maps describe the same source state. Compares key
 * sets, fingerprints, and disabled flags; eviction paths are derived from
 * the same walk as the fingerprint, so equal fingerprints imply equal
 * paths.
 */
function sameVersions(
  a: Readonly<Record<string, PluginSourceVersion>>,
  b: Readonly<Record<string, PluginSourceVersion>>,
): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) {
    return false;
  }
  for (const key of aKeys) {
    const other = b[key];
    if (other === undefined) {
      return false;
    }
    if (
      other.fingerprint !== a[key]!.fingerprint ||
      other.disabled !== a[key]!.disabled
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Watcher state across passes. Seeded from the existing sentinel so a
 * restarted watcher that observes unchanged source adopts the document
 * instead of rewriting it.
 */
export interface SourceWatchState {
  lastPlugins: Record<string, PluginSourceVersion> | null;
  generation: number;
}

/** Create pass state, adopting any existing sentinel document. */
export function createSourceWatchState(): SourceWatchState {
  const existing = readSourceVersions();
  if (existing === null) {
    return { lastPlugins: null, generation: 0 };
  }
  return {
    lastPlugins: { ...existing.plugins },
    generation: existing.generation,
  };
}

/**
 * Compile every multi-file app bundled by a plugin from its `apps/<app>/src`
 * into the sibling `apps/<app>/dist`. Single-file apps (a root `index.html`,
 * no `src/`) need no build and are skipped.
 *
 * Runs here — off the daemon's hot path — because the monitor has just detected
 * the change. The generated `dist/` is excluded from the source fingerprint
 * ({@link isGeneratedAppBuildDir}), so writing it does not re-trigger a pass.
 * The bundler (esbuild) is imported lazily so the monitor only pulls it in when
 * a plugin actually ships a buildable app.
 */
export async function compilePluginApps(pluginDir: string): Promise<void> {
  const appsDir = join(pluginDir, "apps");
  let appEntries: string[];
  try {
    appEntries = readdirSync(appsDir);
  } catch {
    return; // No apps/ directory — nothing to build.
  }
  const buildable = appEntries.filter((app) => {
    const appDir = join(appsDir, app);
    try {
      return statSync(appDir).isDirectory() && existsSync(join(appDir, "src"));
    } catch {
      return false;
    }
  });
  if (buildable.length === 0) {
    return;
  }
  const { compileApp } = await import("../bundler/app-compiler.js");
  for (const app of buildable) {
    const appDir = join(appsDir, app);
    const result = await compileApp(appDir);
    if (!result.ok) {
      log.warn({ appDir, errors: result.errors }, "plugin app compile failed");
    }
  }
}

/**
 * Run one detection pass: walk, compare against the last published state,
 * and rewrite the sentinel if anything changed. Returns whether a rewrite
 * happened. Never throws — a failed pass is logged and retried on the next
 * tick.
 */
export function runSourceWatchPass(state: SourceWatchState): boolean {
  try {
    const current = collectSourceVersions();
    if (
      state.lastPlugins !== null &&
      sameVersions(state.lastPlugins, current)
    ) {
      return false;
    }

    const changedDirs =
      state.lastPlugins === null
        ? Object.keys(current)
        : [
            ...new Set([
              ...Object.keys(state.lastPlugins),
              ...Object.keys(current),
            ]),
          ].filter(
            (dir) =>
              state.lastPlugins![dir]?.fingerprint !==
                current[dir]?.fingerprint ||
              state.lastPlugins![dir]?.disabled !== current[dir]?.disabled,
          );

    state.generation += 1;
    const doc: SourceVersionsDocument = {
      format: SOURCE_VERSIONS_FORMAT,
      generation: state.generation,
      writtenAt: new Date().toISOString(),
      plugins: current,
    };
    writeSentinelAtomically(doc);
    state.lastPlugins = current;

    log.info(
      { generation: state.generation, changedDirs },
      "plugin source change published",
    );

    // Rebuild multi-file apps for each changed, enabled plugin. Fire-and-forget
    // so a slow build never stalls the watch loop; the generated dist is
    // excluded from the fingerprint, so it does not re-trigger this pass.
    for (const dir of changedDirs) {
      const version = current[dir];
      if (version !== undefined && !version.disabled) {
        void compilePluginApps(dir).catch((err) => {
          log.error({ err, dir }, "plugin app compile pass failed");
        });
      }
    }

    return true;
  } catch (err) {
    log.error({ err }, "plugin source watch pass failed — will retry");
    return false;
  }
}

/**
 * Write the sentinel via temp-file + rename so readers never observe a torn
 * document. Both files live in the monitoring data directory, outside every
 * fingerprint walk and outside the workspace git surface.
 */
function writeSentinelAtomically(doc: SourceVersionsDocument): void {
  const path = getSourceVersionsPath();
  mkdirSync(getMonitoringDataDir(), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(doc, null, 2));
  renameSync(tmpPath, path);
}

/** Handle for the running watcher loop. */
export interface PluginSourceWatchHandle {
  stop(): void;
}

/**
 * Start the watcher loop: one pass immediately (so a fresh boot publishes a
 * baseline without waiting a full interval), then one per `intervalMs`.
 * Passes are synchronous, so ticks never overlap.
 */
export function startPluginSourceWatch(
  intervalMs: number,
): PluginSourceWatchHandle {
  const state = createSourceWatchState();
  runSourceWatchPass(state);
  const timer = setInterval(() => {
    runSourceWatchPass(state);
  }, intervalMs);
  return {
    stop: () => clearInterval(timer),
  };
}
