/**
 * How a child process learns which plugin it is running as.
 *
 * In-process plugin hooks, tools, and routes use AsyncLocalStorage
 * ({@link getCurrentPluginName}). A bash or skill-sandbox child does not
 * inherit that store. Those children recover the install-directory basename
 * from `VELLUM_PLUGIN_NAME` (injected after env sanitization) or from the
 * entry script path under `plugins/<service>/skills/<skill>/{scripts,tools}/`.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { getCurrentPluginName } from "../plugins/plugin-execution-context.js";
import { getWorkspacePluginsDir } from "../util/platform.js";

export const PLUGIN_NAME_ENV = "VELLUM_PLUGIN_NAME";

const SKILL_SCRIPT_ROOTS = new Set(["scripts", "tools"]);

/**
 * Read a plugin install-directory name from the process environment.
 * Empty or whitespace-only values are ignored.
 */
export function readPluginNameFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env[PLUGIN_NAME_ENV];
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * If `filePath` is a skill script or tool under an installed plugin, return
 * that plugin's install-directory basename (the runtime service name).
 *
 * Expected layout:
 * `plugins/<service>/skills/<skill-id>/scripts|tools/<file>`.
 */
export function derivePluginNameFromSkillScriptPath(
  filePath: string,
  pluginsDir: string = getWorkspacePluginsDir(),
): string | undefined {
  if (filePath.length === 0) {
    return undefined;
  }
  let resolved = filePath;
  if (filePath.startsWith("file:")) {
    try {
      resolved = fileURLToPath(filePath);
    } catch {
      return undefined;
    }
  }
  if (!isAbsolute(resolved)) {
    resolved = resolve(process.cwd(), resolved);
  }
  const pluginsRoot = resolve(pluginsDir);
  const rel = relative(pluginsRoot, resolved);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
    return undefined;
  }
  const parts = rel.split(sep).filter((part) => part.length > 0);
  if (parts.length < 5) {
    return undefined;
  }
  const [service, skillsSeg, skillId, root] = parts;
  if (
    service === undefined ||
    skillsSeg !== "skills" ||
    skillId === undefined ||
    root === undefined ||
    !SKILL_SCRIPT_ROOTS.has(root)
  ) {
    return undefined;
  }
  return service;
}

/**
 * Scan argv for a plugin-resident skill script path, resolving relative
 * entries against `cwd`.
 */
export function derivePluginNameFromProcess(
  argv: readonly string[] = process.argv,
  cwd: string = process.cwd(),
  pluginsDir: string = getWorkspacePluginsDir(),
): string | undefined {
  for (const candidate of argv.slice(1)) {
    if (typeof candidate !== "string" || candidate.length === 0) {
      continue;
    }
    if (candidate.startsWith("-")) {
      continue;
    }
    const absolute = isAbsolute(candidate)
      ? candidate
      : resolve(cwd, candidate);
    const name = derivePluginNameFromSkillScriptPath(absolute, pluginsDir);
    if (name !== undefined) {
      return name;
    }
  }
  return undefined;
}

/**
 * Plugin identity for credential scoping: in-process AsyncLocalStorage,
 * then the injected env var, then the process entry script path.
 */
export function resolveCallingPluginName(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
  cwd: string = process.cwd(),
  pluginsDir: string = getWorkspacePluginsDir(),
): string | undefined {
  return (
    getCurrentPluginName() ??
    readPluginNameFromEnv(env) ??
    derivePluginNameFromProcess(argv, cwd, pluginsDir)
  );
}
