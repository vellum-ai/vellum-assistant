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

/** The surfaces an installed plugin contributes, each sorted and de-duplicated. */
export interface PluginSurfaces {
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
   * importing and executing untrusted plugin code, which inspection avoids.
   */
  readonly tools: readonly string[];
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
 * Detect the {@link PluginSurfaces} an installed plugin contributes by walking
 * its install tree at `pluginDir`. Surface types with no contributions come
 * back as empty arrays; callers omit empty types from the rendered output.
 */
export function detectPluginSurfaces(pluginDir: string): PluginSurfaces {
  const toolNames = listModuleBasenames(join(pluginDir, "tools")).map(
    deriveToolName,
  );
  return {
    skills: listSkillIds(join(pluginDir, "skills")),
    hooks: listModuleBasenames(join(pluginDir, "hooks")),
    tools: [...new Set(toolNames)].sort(),
  };
}
