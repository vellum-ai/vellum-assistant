/**
 * Install a staged plugin's declared runtime dependencies.
 *
 * A plugin is materialized by cloning (or extracting) its source tree — the
 * installer never ran `bun install`, so a plugin that declares its own
 * `dependencies` in `package.json` shipped no way to resolve them: its hooks'
 * and tools' bare imports (`import { ... } from "date-fns"`) had nothing to
 * resolve against. The workspace-level shims cover only the tiny curated set
 * (`@vellumai/plugin-api`, the whitelisted shared deps like `zod`); anything a
 * plugin brings itself was unresolvable.
 *
 * This module closes that gap: after the tree is staged and before it is
 * swapped into place, the plugin's own `dependencies` are installed into
 * `<pluginDir>/node_modules/` so Node-style resolution walking up from a
 * hook/tool file finds them. The install is:
 *
 * - **`--omit=dev`** — only runtime `dependencies`, never `devDependencies`
 *   (a plugin's build-time tooling has no place in an installed copy).
 * - **peers installed, except the host shim** — bun installs `peerDependencies`
 *   by default, and a plugin may legitimately declare a non-host peer (e.g.
 *   `react`) it imports at runtime, so peers are kept. The sole exception is
 *   `@vellumai/plugin-api`: every adapted plugin declares it as a peer (see
 *   {@link ./install-from-github} `normalizeInstalledManifest`), but that
 *   package is a workspace shim materialized at daemon startup
 *   (`../../plugins/ensure-plugin-api-shim.ts`), not a registry package.
 *   Resolving it would either fail (a dev/unpublished version) or plant a
 *   detached registry copy that *shadows* the live, daemon-wired shim. So the
 *   plugin-api peer alone is stripped from a scratch copy of the manifest for
 *   the duration of the install, then the original manifest is restored verbatim
 *   (bun runs with `--no-save`, so it never writes the manifest itself).
 * - **`--ignore-scripts`** — no dependency (or root) lifecycle script runs, so
 *   installing a plugin never executes arbitrary `postinstall` code. Curated
 *   adapter transforms run through their own vetted path (see
 *   {@link ./install-from-github}), not here.
 * - **`--no-save`** — no lockfile is written and bun does not touch the
 *   manifest, so the only artifact is `node_modules/`, which every plugin-tree
 *   walk already excludes (see `../../plugins/plugin-tree-walk.ts`). The
 *   manifest ends byte-for-byte as materialized (restored after the strip above).
 *
 * `node_modules/` is intentionally *not* fingerprinted, preserved across
 * upgrades, or otherwise treated as source: it is derived from the pinned
 * `package.json` and re-installed on every (re)install and upgrade.
 *
 * Designed for direct programmatic use with an injectable runner, mirroring the
 * sibling plugin libraries; production callers fall back to
 * {@link defaultDependencyInstaller}.
 */

import { execFile } from "node:child_process";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { ensureBun } from "../../util/bun-runtime.js";
import { getLogger } from "../../util/logger.js";

const execFileAsync = promisify(execFile);

const log = getLogger("plugin-deps");

/** Cap on a single dependency install; a plugin's dependency set is small. */
const DEPENDENCY_INSTALL_TIMEOUT_MS = 120_000;

/**
 * The workspace-shim peer stripped from the manifest for the duration of the
 * install so bun never resolves it (see the module docstring). Other peers are
 * kept and installed normally.
 */
const PLUGIN_API_PACKAGE = "@vellumai/plugin-api";

/**
 * `bun install` argv for a plugin's dependencies. Peers are installed (bun's
 * default) so a plugin's non-host peers resolve; the `@vellumai/plugin-api`
 * shim is withheld by stripping it from the manifest, not by omitting all peers
 * (see the module docstring). Exported so a guard test pins the flag set against
 * silent regressions.
 */
export const DEPENDENCY_INSTALL_ARGS: readonly string[] = Object.freeze([
  "install",
  "--omit=dev",
  "--ignore-scripts",
  "--no-save",
]);

/**
 * Installs a staged plugin's dependencies in `cwd`. Injected so tests can
 * assert the install is invoked (and simulate its effects) without spawning a
 * real subprocess; production callers fall back to
 * {@link defaultDependencyInstaller}.
 */
export type DependencyInstaller = (opts: {
  /** The staged plugin directory whose `dependencies` are installed. */
  readonly cwd: string;
}) => Promise<void>;

/**
 * The plugin's `package.json` could not be restored to its original bytes after
 * the dependency install temporarily stripped the `@vellumai/plugin-api` peer.
 * Thrown so {@link ./install-from-github.finalizeStagedInstall} aborts rather
 * than fingerprint and swap in a plugin whose manifest is left shim-stripped.
 */
export class PluginManifestRestoreError extends Error {
  constructor(
    readonly pluginDir: string,
    readonly cause: unknown,
  ) {
    super(
      `Failed to restore package.json for the plugin at ${pluginDir} after installing its dependencies; aborting to avoid installing a shim-stripped manifest.`,
    );
    this.name = "PluginManifestRestoreError";
  }
}

/**
 * Write `contents` to `path` atomically: a full write to a sibling temp file
 * followed by a rename. `package.json` is therefore only ever the complete old
 * bytes or the complete new bytes — never a truncated/partial write a failed
 * `writeFileSync` could otherwise leave behind. The temp file shares `path`'s
 * directory so the rename stays on one filesystem (atomic on POSIX); a failed
 * write cleans the temp file up before rethrowing.
 */
function writeFileAtomic(path: string, contents: string): void {
  const tmp = `${path}.deps-install.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, contents);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** How a plugin's dependencies should be installed, or `null` to skip. */
interface ManifestInstallPlan {
  /** Original `package.json` bytes, restored verbatim after the install. */
  readonly originalManifest: string;
  /**
   * Manifest bytes to write for the duration of the install — a copy with only
   * the `@vellumai/plugin-api` peer removed — or `null` when the manifest needs
   * no rewrite (it declares no plugin-api peer, so it installs as-is).
   */
  readonly installManifest: string | null;
}

/** A non-empty plain-object record at `value`, or `null`. */
function nonEmptyRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record).length > 0 ? record : null;
}

/**
 * Decide whether — and how — to install `pluginDir`'s dependencies.
 *
 * Returns `null` when there is nothing to install: a missing/unparseable
 * manifest, or one whose only installable declarations are the host-provided
 * `@vellumai/plugin-api` peer (the common case for plugins that import only the
 * plugin-api and whitelisted shared deps).
 *
 * Otherwise the plan carries the original manifest bytes and, when the manifest
 * declares the plugin-api peer, a rewritten copy with *only* that peer removed.
 * Every other peer (e.g. `react`) is kept so bun installs it as a normal install
 * would; only the shim — which the daemon provides at runtime and which must
 * never be shadowed by a registry copy — is withheld.
 */
function planManifestForInstall(pluginDir: string): ManifestInstallPlan | null {
  const pkgPath = join(pluginDir, "package.json");
  if (!existsSync(pkgPath)) {
    return null;
  }
  let originalManifest: string;
  let parsed: unknown;
  try {
    originalManifest = readFileSync(pkgPath, "utf8");
    parsed = JSON.parse(originalManifest);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const manifest = parsed as Record<string, unknown>;

  const peers = nonEmptyRecord(manifest.peerDependencies);
  const hasPluginApiPeer = peers !== null && PLUGIN_API_PACKAGE in peers;
  const hasNonApiPeer =
    peers !== null &&
    Object.keys(peers).some((name) => name !== PLUGIN_API_PACKAGE);

  const hasDeps = nonEmptyRecord(manifest.dependencies) !== null;
  const hasOptionalDeps =
    nonEmptyRecord(manifest.optionalDependencies) !== null;

  if (!hasDeps && !hasOptionalDeps && !hasNonApiPeer) {
    // Only the plugin-api peer (or nothing) — bun would install nothing once it
    // is stripped, so skip the subprocess entirely.
    return null;
  }

  if (!hasPluginApiPeer) {
    return { originalManifest, installManifest: null };
  }

  // Strip only the plugin-api peer; the install manifest need only be valid
  // JSON bun can read, since the original is restored verbatim afterward.
  const strippedPeers = { ...peers };
  delete strippedPeers[PLUGIN_API_PACKAGE];
  const installManifest: Record<string, unknown> = { ...manifest };
  if (Object.keys(strippedPeers).length > 0) {
    installManifest.peerDependencies = strippedPeers;
  } else {
    delete installManifest.peerDependencies;
  }
  return {
    originalManifest,
    installManifest: `${JSON.stringify(installManifest, null, 2)}\n`,
  };
}

/**
 * Install the plugin's declared dependencies (and non-host peers) into
 * `<pluginDir>/node_modules/`, a no-op when it declares nothing installable.
 *
 * The `@vellumai/plugin-api` peer is stripped from the manifest for the duration
 * of the install and restored afterward (see the module docstring), so the
 * daemon-provided shim is never resolved or shadowed and `package.json` ends
 * byte-for-byte as materialized.
 *
 * Fail-soft by design for the *install* itself: a dependency-install failure
 * (offline, an unresolvable version, a registry outage) is logged and swallowed
 * rather than aborting the install. The plugin's code is already materialized; a
 * plugin that then can't resolve a missing dependency fails at load with a clear
 * module-not-found the user can act on by reinstalling once connectivity returns
 * — strictly better than throwing away a completed materialization over a
 * transient network error.
 *
 * Manifest integrity is *not* fail-soft. The stripped copy is written and
 * restored atomically, so `package.json` is never a truncated/partial write. If
 * the manifest cannot be restored to its original bytes afterward, this throws
 * {@link PluginManifestRestoreError} so the caller aborts rather than swap in a
 * plugin whose manifest is left shim-stripped.
 */
export async function installPluginDependencies(
  pluginDir: string,
  run: DependencyInstaller = defaultDependencyInstaller,
): Promise<void> {
  const plan = planManifestForInstall(pluginDir);
  if (!plan) {
    return;
  }

  const pkgPath = join(pluginDir, "package.json");
  if (plan.installManifest !== null) {
    try {
      writeFileAtomic(pkgPath, plan.installManifest);
    } catch (err) {
      // The atomic stage failed, so package.json is untouched (still the
      // original) — skip the install rather than resolve (and shadow) the shim.
      // Nothing to restore.
      log.warn(
        { err, pluginDir },
        "could not stage manifest for plugin dependency install — skipping",
      );
      return;
    }
  }

  try {
    await run({ cwd: pluginDir });
    log.info({ pluginDir }, "installed plugin dependencies");
  } catch (err) {
    log.warn(
      { err, pluginDir },
      "plugin dependency install failed — imports of a missing dependency will fail at load; reinstall to retry",
    );
  } finally {
    if (plan.installManifest !== null) {
      try {
        writeFileAtomic(pkgPath, plan.originalManifest);
      } catch (err) {
        // The manifest is left with the plugin-api peer stripped (a complete
        // file — the write is atomic — but not the materialized bytes). Abort
        // finalization rather than swap a shim-stripped plugin into place.
        throw new PluginManifestRestoreError(pluginDir, err);
      }
    }
  }
}

/**
 * Production dependency installer: runs `bun install` with a real `bun` binary
 * resolved via {@link ensureBun}, under a timeout. `--omit=dev` skips
 * devDependencies, `--ignore-scripts` blocks all lifecycle scripts, and
 * `--no-save` writes no lockfile and does not touch the manifest. Peers install
 * by default; the plugin-api shim is withheld by the manifest strip in
 * {@link installPluginDependencies}, not by a flag here.
 *
 * `process.execPath` is unusable here: inside a `bun build --compile` binary it
 * is the compiled assistant app, not the bun CLI (see `util/bun-runtime.ts`),
 * so `ensureBun()` locates (or downloads) a standalone bun the same way every
 * other subsystem that spawns bun does.
 */
export const defaultDependencyInstaller: DependencyInstaller = async ({
  cwd,
}) => {
  const bun = await ensureBun();
  await execFileAsync(bun, [...DEPENDENCY_INSTALL_ARGS], {
    cwd,
    encoding: "utf8",
    timeout: DEPENDENCY_INSTALL_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    env: dependencyInstallEnv(bun),
  });
};

/**
 * Environment for the `bun install` subprocess. The full process environment
 * is inherited so registry/proxy configuration (`HTTPS_PROXY`, npm config, …)
 * flows through — safe because `--ignore-scripts` means no dependency code
 * runs — with the resolved bun's directory prepended to `PATH` so the runtime
 * is found even when the daemon launched from a minimal-environment macOS
 * `.app` bundle.
 */
function dependencyInstallEnv(bun: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const bunDir = dirname(bun);
  const current = (env.PATH ?? "").split(":").filter(Boolean);
  if (!current.includes(bunDir)) {
    env.PATH = [bunDir, ...current].join(":");
  }
  return env;
}
