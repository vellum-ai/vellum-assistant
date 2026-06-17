/**
 * Detect the surfaces an installed plugin contributes to the running assistant,
 * read directly from its on-disk tree.
 *
 * The host discovers a plugin's contributions from fixed directory conventions:
 *
 * - `hooks/<name>.{ts,js}`     → a lifecycle hook keyed by the file basename
 *                                (see the external plugin loader's `loadHooks`).
 * - `tools/<name>.{ts,js}`     → a tool, also keyed by the file basename
 *                                (see the external plugin loader's tool walk).
 * - `skills/<id>/SKILL.md`     → a skill owned by the plugin (see the skills
 *                                catalog's `discoverPluginResidentSkills`).
 *
 * This module re-derives those same sets so `plugins inspect` can report exactly
 * what a plugin contributes. Detection is intentionally a self-contained walk of
 * the install tree — `cli/lib` does not reach into the daemon-internal loader or
 * skills catalog — but it mirrors their conventions so inspect agrees with what
 * the runtime actually loads.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The surfaces an installed plugin contributes, read from its on-disk tree —
 * each list sorted and de-duplicated. This is a pure filesystem view: it says
 * what the plugin *ships*, not what the running daemon actually loaded.
 */
export interface PluginContributedSurfaces {
  /** Skill ids shipped at `skills/<id>/SKILL.md`. */
  readonly skills: readonly string[];
  /** Lifecycle hook names from `hooks/<name>.{ts,js}` (e.g. `pre-model-call`). */
  readonly hooks: readonly string[];
  /**
   * Registered tool names from `tools/<name>.{ts,js}`. The loader derives a
   * tool's name from its filename via {@link deriveToolName} (e.g.
   * `create-issue.ts` registers as `create_issue`), so the derived form is
   * reported rather than the raw basename. A tool module that overrides its own
   * name via an exported `name` is not reflected here: that would require
   * importing and executing untrusted plugin code, which the disk walk avoids
   * (the live {@link PluginSurfaces.registered} view does reflect it).
   */
  readonly tools: readonly string[];
}

/**
 * The subset of a plugin's hook/tool surfaces that are actually live in the
 * running daemon's in-memory registries — read straight from the registries,
 * not the disk tree. Authoritative for "what does the runtime currently
 * expose": a hook file that failed to load is absent here, and a tool that
 * renamed itself via an exported `name` appears under its real registered name.
 */
export interface RegisteredPluginSurfaces {
  /** Hook names registered in the daemon's plugin registry for this plugin. */
  readonly hooks: readonly string[];
  /** Tool names registered in the daemon's tool registry owned by this plugin. */
  readonly tools: readonly string[];
}

/**
 * The inspection view of a plugin's surfaces: what it contributes on disk, plus
 * the subset actually registered in the live daemon when one could be consulted.
 */
export interface PluginSurfaces extends PluginContributedSurfaces {
  /**
   * The subset of {@link PluginContributedSurfaces.hooks} and
   * {@link PluginContributedSurfaces.tools} actually registered in the running
   * daemon's in-memory registries, or `null` when the daemon could not be
   * consulted (e.g. it is not running, or this view was produced offline).
   * `null` means "unknown", distinct from an object of empty arrays, which
   * means "the daemon is running but has nothing registered for this plugin".
   */
  readonly registered: RegisteredPluginSurfaces | null;
}

/**
 * Derive a tool's registered name from its file basename, mirroring the
 * external plugin loader's `deriveToolName`: non-alphanumeric runs collapse to
 * `_`, leading/trailing `_` are trimmed, and an empty result falls back to
 * `tool`. Keeps the inspected tool name aligned with the callable tool name.
 */
function deriveToolName(basename: string): string {
  return (
    basename.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "tool"
  );
}

/**
 * List the basenames of every `.ts`/`.js` module directly under `dir`,
 * preferring `.js` over `.ts` for the same basename (compiled-binary semantics)
 * and skipping `.d.ts` declaration files. Returns names sorted for a
 * deterministic listing. A missing or non-directory path yields `[]`.
 *
 * Mirrors the external plugin loader's `listSurfaceDir`, the gate it uses to
 * turn a `hooks/`/`tools/` directory into loadable surfaces.
 */
function listModuleBasenames(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const bases = new Set<string>();
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith(".d.ts")) continue;
    if (!entry.endsWith(".ts") && !entry.endsWith(".js")) continue;
    bases.add(entry.slice(0, -3));
  }
  return [...bases].sort();
}

/**
 * List the skill ids a plugin ships: each subdirectory of `skills/` that
 * contains a `SKILL.md`. Mirrors the skills catalog's plugin-resident skill
 * discovery so inspect reports the same set the runtime would surface.
 */
function listSkillIds(skillsDir: string): string[] {
  if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) return [];
  const ids: string[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (existsSync(join(skillsDir, entry.name, "SKILL.md"))) {
      ids.push(entry.name);
    }
  }
  return ids.sort();
}

/**
 * Detect the {@link PluginContributedSurfaces} an installed plugin contributes
 * by walking its install tree at `pluginDir`. Surface types with no
 * contributions come back as empty arrays; callers omit empty types from the
 * rendered output. This is the disk view only — pairing it with the live
 * {@link RegisteredPluginSurfaces} is the caller's job (see `inspectPlugin`).
 */
export function detectPluginSurfaces(
  pluginDir: string,
): PluginContributedSurfaces {
  const toolNames = listModuleBasenames(join(pluginDir, "tools")).map(
    deriveToolName,
  );
  return {
    skills: listSkillIds(join(pluginDir, "skills")),
    hooks: listModuleBasenames(join(pluginDir, "hooks")),
    tools: [...new Set(toolNames)].sort(),
  };
}
