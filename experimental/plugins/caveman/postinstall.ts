/**
 * Postinstall adapter that massages the upstream `caveman` Claude Code plugin
 * into a plugin the Vellum loader can run.
 *
 * Why this exists: `caveman` (https://github.com/JuliusBrussee/caveman) ships a
 * Claude Code plugin layout — a `.claude-plugin/plugin.json` manifest whose
 * behavior lives in `SessionStart`/`UserPromptSubmit` hooks that shell out to
 * bundled `node` scripts, plus the ruleset prose in `skills/caveman/SKILL.md`.
 * Vellum's loader expects a different shape: a `package.json` whose `name`
 * matches the directory and that declares the `@vellumai/plugin-api` peer
 * dependency, with hooks as `hooks/<hook-name>.ts` modules (default export =
 * the hook function). Installed verbatim, caveman therefore loads as a
 * name-mismatched, peer-dep-less directory with no Vellum hooks, so it does
 * nothing.
 *
 * This adapter is curated, reviewed Vellum code (it lives in our repo, not the
 * upstream clone) and is invoked via npm's native `scripts.postinstall` after
 * the installer overlays it onto the freshly cloned tree. It never executes
 * caveman's own lifecycle scripts. It performs a deterministic, file-only
 * translation:
 *   1. Augments the overlaid stub `package.json` with the `@vellumai/plugin-api`
 *      peer dependency (the stub already supplies the correct `name`, so we
 *      never overwrite it), and drops the now-spent `postinstall` script so the
 *      installed plugin carries no install-time machinery.
 *   2. Reads `skills/caveman/SKILL.md` — caveman's single source of truth for
 *      the terse-mode ruleset — and strips its YAML frontmatter.
 *   3. Renders the `templates/pre-model-call.ts.tmpl` hook template with that
 *      ruleset into `hooks/pre-model-call.ts`, which appends the ruleset to the
 *      system prompt of the user-facing model call so terse mode is always on.
 *
 * Runs with the staged install directory as its working directory. Any missing
 * input throws, which fails the install (the installer rolls back staging)
 * rather than materializing a half-translated, non-functional plugin.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_API_RANGE = ">=0.8.0";
const RULESET_PLACEHOLDER = "{{{RULESET_JSON}}}";
const root = process.cwd();

/** Read a required file from the staged tree, failing the install if absent. */
function readRequired(relPath: string): string {
  try {
    return readFileSync(join(root, relPath), "utf8");
  } catch (err) {
    throw new Error(
      `caveman adapter: expected file ${relPath} not found ` +
        `(${err instanceof Error ? err.message : String(err)}). The plugin ` +
        `layout may have changed; the adapter needs updating.`,
    );
  }
}

/** Strip a leading YAML frontmatter block (`---` … `---`) from markdown. */
function stripFrontmatter(markdown: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown);
  return (match ? markdown.slice(match[0].length) : markdown).trim();
}

interface PackageJson {
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

// Read every input up front so a missing file aborts before we write anything.
const pkg = JSON.parse(readRequired("package.json")) as PackageJson;
const ruleset = stripFrontmatter(readRequired("skills/caveman/SKILL.md"));
if (ruleset.length === 0) {
  throw new Error("caveman adapter: SKILL.md ruleset is empty after parsing.");
}
const template = readRequired("templates/pre-model-call.ts.tmpl");

// Augment the overlaid stub package.json in place rather than overwriting it:
// add the peer dependency the loader checks for if it is absent, and remove the
// spent postinstall script so the installed plugin carries no install-time
// machinery. The stub already declares the correct `name`.
pkg.peerDependencies = {
  ...pkg.peerDependencies,
  "@vellumai/plugin-api":
    pkg.peerDependencies?.["@vellumai/plugin-api"] ?? PLUGIN_API_RANGE,
};
if (pkg.scripts) {
  delete pkg.scripts.postinstall;
  if (Object.keys(pkg.scripts).length === 0) delete pkg.scripts;
}
writeFileSync(
  join(root, "package.json"),
  `${JSON.stringify(pkg, null, 2)}\n`,
  "utf8",
);

// `JSON.stringify` yields a valid TypeScript string literal, so the ruleset —
// arbitrary markdown with backticks and `${...}` — embeds safely without
// hand-escaping. `split`/`join` substitutes the placeholder literally, so a `$`
// in the ruleset can't be misread as a `String.replace` replacement pattern.
const hook = template.split(RULESET_PLACEHOLDER).join(JSON.stringify(ruleset));
mkdirSync(join(root, "hooks"), { recursive: true });
writeFileSync(join(root, "hooks", "pre-model-call.ts"), hook, "utf8");
