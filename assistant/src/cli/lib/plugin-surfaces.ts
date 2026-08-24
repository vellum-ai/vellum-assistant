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
 * - `schedules/<name>/`        → a declared schedule (see the daemon's plugin
 *                                schedule declaration parser).
 *
 * This module re-derives those same sets so `plugins inspect` can report exactly
 * what a plugin contributes. Detection is intentionally a self-contained walk of
 * the install tree (`cli/lib` does not reach into the daemon-internal loader,
 * skills catalog, or schedule parser), but it mirrors their conventions so
 * inspect agrees with what the runtime actually loads.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** A schedule the plugin declares under `schedules/`. */
export interface PluginScheduleSurface {
  /** Schedule name: the declaration directory's name. */
  readonly name: string;
  /** Raw schedule `expression` string from the declaration's config. */
  readonly cadence: string;
  /** `execute` for a markdown prompt entrypoint, `script` for `index.sh`. */
  readonly mode: "execute" | "script";
}

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
  /**
   * Schedules declared under `schedules/`, each a `<name>/` directory with a
   * `config.json` plus exactly one `index.md` (`execute`) or `index.sh`
   * (`script`) entrypoint. This is a display surface, not the arming path:
   * a file directly under `schedules/` and structurally malformed directories
   * (a bad entrypoint set, an empty prompt body, frontmatter in `index.md`, an
   * unreadable config, a missing `expression`) are skipped rather than reported
   * as errors. Detection stays permissive beyond structure: `expression`
   * validity is not checked CLI-side, so a declaration whose expression the
   * daemon rejects is still listed here.
   */
  readonly schedules: readonly PluginScheduleSurface[];
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
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return [];
  }
  const bases = new Set<string>();
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith(".d.ts")) {
      continue;
    }
    if (!entry.endsWith(".ts") && !entry.endsWith(".js")) {
      continue;
    }
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
  if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) {
    return [];
  }
  const ids: string[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    if (existsSync(join(skillsDir, entry.name, "SKILL.md"))) {
      ids.push(entry.name);
    }
  }
  return ids.sort();
}

/** Matches a `---` delimited YAML frontmatter block at the start of a file. */
const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** Read the raw `expression` string from a parsed schedule config, or `null`. */
function readConfigExpression(config: unknown): string | null {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return null;
  }
  const expression = (config as Record<string, unknown>).expression;
  return typeof expression === "string" && expression.trim() !== ""
    ? expression
    : null;
}

/**
 * Read a `<name>/` directory declaration: `config.json` supplies the cadence
 * and the single `index.md`/`index.sh` entrypoint decides the mode. `null` for
 * anything the loader would refuse (zero or multiple `index.*` entries, an
 * unsupported entrypoint, an `index.md` carrying frontmatter or an empty
 * prompt body, an unreadable config, a missing expression).
 */
function readDirectorySchedule(
  dirPath: string,
): { cadence: string; mode: PluginScheduleSurface["mode"] } | null {
  let children;
  try {
    children = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }
  const entrypoints = children
    .filter((c) => c.isFile() && c.name.startsWith("index."))
    .map((c) => c.name);
  if (entrypoints.length !== 1) {
    return null;
  }
  const entrypoint = entrypoints[0]!;
  if (entrypoint !== "index.md" && entrypoint !== "index.sh") {
    return null;
  }
  if (entrypoint === "index.md") {
    let body: string;
    try {
      body = readFileSync(join(dirPath, "index.md"), "utf8");
    } catch {
      return null;
    }
    // Directory-form config belongs in config.json, so the loader refuses an
    // index.md with frontmatter; it also refuses an empty prompt body.
    if (FRONTMATTER_REGEX.test(body) || !body.trim()) {
      return null;
    }
  }
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(join(dirPath, "config.json"), "utf8"));
  } catch {
    return null;
  }
  const cadence = readConfigExpression(config);
  if (cadence === null) {
    return null;
  }
  return { cadence, mode: entrypoint === "index.md" ? "execute" : "script" };
}

/**
 * List the schedules a plugin declares under `schedules/`, mirroring the
 * declaration parser's directory-only form. A file directly under
 * `schedules/` is not a declaration, so it is skipped. Returns schedules
 * sorted by name; a missing directory yields `[]`.
 */
function listSchedules(schedulesDir: string): PluginScheduleSurface[] {
  let entries;
  try {
    entries = readdirSync(schedulesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const schedules: PluginScheduleSurface[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || !entry.isDirectory()) {
      continue;
    }
    const parsed = readDirectorySchedule(join(schedulesDir, entry.name));
    if (parsed) {
      schedules.push({ name: entry.name, ...parsed });
    }
  }
  return schedules.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

/**
 * Skill id a plugin ships for first-run setup, if any.
 *
 * Convention: `skills/setup/SKILL.md` or `skills/<plugin-name>-setup/SKILL.md`.
 * The directory name is the id `skill_load` uses. `setup` wins when both exist
 * so the generic name is the standard; `<plugin-name>-setup` covers plugins
 * that already ship that form.
 */
export function findPluginSetupSkill(
  pluginName: string,
  skillIds: readonly string[],
): string | undefined {
  if (skillIds.includes("setup")) {
    return "setup";
  }
  const named = `${pluginName}-setup`;
  if (skillIds.includes(named)) {
    return named;
  }
  return undefined;
}

/** Install-command copy pointing at a plugin's setup skill. */
export function formatPluginSetupHint(skillId: string): string {
  return `Load the ${skillId} skill to help set up this plugin`;
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
    schedules: listSchedules(join(pluginDir, "schedules")),
  };
}
