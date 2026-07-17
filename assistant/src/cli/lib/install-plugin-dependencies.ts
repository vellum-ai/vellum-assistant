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
 * - **`--production`** — only runtime `dependencies`, never `devDependencies`
 *   (a plugin's build-time tooling has no place in an installed copy).
 * - **`--ignore-scripts`** — no dependency (or root) lifecycle script runs, so
 *   installing a plugin never executes arbitrary `postinstall` code. Curated
 *   adapter transforms run through their own vetted path (see
 *   {@link ./install-from-github}), not here.
 * - **`--no-save`** — `package.json` is left byte-for-byte as materialized and
 *   no lockfile is written, so the only artifact is `node_modules/`, which every
 *   plugin-tree walk already excludes (see `../../plugins/plugin-tree-walk.ts`).
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
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { ensureBun } from "../../util/bun-runtime.js";
import { getLogger } from "../../util/logger.js";

const execFileAsync = promisify(execFile);

const log = getLogger("plugin-deps");

/** Cap on a single dependency install; a plugin's dependency set is small. */
const DEPENDENCY_INSTALL_TIMEOUT_MS = 120_000;

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
 * Whether the plugin at `pluginDir` declares any runtime `dependencies`. A
 * missing/unparseable manifest, or one with no (or an empty) `dependencies`
 * object, means there is nothing to install — the common case for the many
 * plugins that import only the plugin-api and whitelisted shared deps.
 */
function hasRuntimeDependencies(pluginDir: string): boolean {
  const pkgPath = join(pluginDir, "package.json");
  if (!existsSync(pkgPath)) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return false;
    }
    const deps = (parsed as { dependencies?: unknown }).dependencies;
    return (
      typeof deps === "object" &&
      deps !== null &&
      !Array.isArray(deps) &&
      Object.keys(deps).length > 0
    );
  } catch {
    return false;
  }
}

/**
 * Install the plugin's declared runtime dependencies into
 * `<pluginDir>/node_modules/`, a no-op when it declares none.
 *
 * Fail-soft by design: a dependency-install failure (offline, an unresolvable
 * version, a registry outage) is logged and swallowed rather than aborting the
 * install. The plugin's code is already materialized; a plugin that then can't
 * resolve a missing dependency fails at load with a clear module-not-found the
 * user can act on by reinstalling once connectivity returns — strictly better
 * than throwing away a completed materialization over a transient network
 * error.
 */
export async function installPluginDependencies(
  pluginDir: string,
  run: DependencyInstaller = defaultDependencyInstaller,
): Promise<void> {
  if (!hasRuntimeDependencies(pluginDir)) {
    return;
  }
  try {
    await run({ cwd: pluginDir });
    log.info({ pluginDir }, "installed plugin dependencies");
  } catch (err) {
    log.warn(
      { err, pluginDir },
      "plugin dependency install failed — imports of a missing dependency will fail at load; reinstall to retry",
    );
  }
}

/**
 * Production dependency installer: runs `bun install` with a real `bun` binary
 * resolved via {@link ensureBun}, under a timeout. `--production` skips
 * devDependencies, `--ignore-scripts` blocks all lifecycle scripts, and
 * `--no-save` leaves `package.json` untouched and writes no lockfile.
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
  await execFileAsync(
    bun,
    ["install", "--production", "--ignore-scripts", "--no-save"],
    {
      cwd,
      encoding: "utf8",
      timeout: DEPENDENCY_INSTALL_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      env: dependencyInstallEnv(bun),
    },
  );
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
