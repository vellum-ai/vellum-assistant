import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatterFields } from "../skills/frontmatter.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import { stripCommentLines } from "../util/strip-comment-lines.js";

const log = getLogger("system-prompt-sections");

/**
 * Render context passed by the caller of `renderWorkspaceSections`. Sections
 * declare their `enabled` predicate in YAML frontmatter, and the predicate
 * is evaluated against keys in this object.
 *
 * Intentionally an open record — the registry never references specific keys.
 * Callers (currently `buildSystemPrompt`) hand in the same options object
 * they received, so any field on `BuildSystemPromptOptions` can be
 * referenced by name in a section's frontmatter.
 */
export type SectionRenderContext = Record<string, unknown>;

/**
 * Workspace location for editable system prompt section files.
 * Layout: `<workspace>/prompts/system/<NN-name>.md`.
 *
 * The bundled `templates/system/` directory shipped with the daemon is the
 * seed corpus: `ensurePromptFiles()` (in `system-prompt.ts`) copies any
 * missing template into this directory at startup.  The renderer never
 * reads from the bundled directory — once seeded, the workspace is the
 * single source of truth.
 */
export function getWorkspaceSystemPromptDir(): string {
  return join(getWorkspaceDir(), "prompts", "system");
}

/**
 * Render every `<NN-name>.md` file under `<workspace>/prompts/system/` in
 * filename order, returning the trimmed body of each enabled section.
 *
 * Discovery is filesystem-driven and workspace-only — there is no in-code
 * registry of section ids and the renderer never falls back to the bundled
 * directory.  `ensurePromptFiles()` runs at daemon startup and copies any
 * missing bundled section template into the workspace; from that point on
 * the workspace file IS the contract.
 *
 * Render contract per section:
 *   1. read `<workspace>/prompts/system/<id>.md`
 *   2. parse YAML frontmatter (optional); body is everything after
 *   3. evaluate `enabled` against `ctx`; falsy → skip
 *   4. strip lines starting with `_` (legacy inline-comment convention)
 *   5. trim; emit if non-empty, otherwise skip
 *
 * The empty-body case is intentional — it lets a user silence a section by
 * clearing its file without deleting it.  Deleting the file removes it from
 * discovery entirely until the next `ensurePromptFiles()` re-seeds it.
 *
 * Drop a new `<NN-name>.md` into the workspace dir and it joins the render
 * order automatically.  The numeric prefix is load-bearing for sort order;
 * pick a number that places the section where it should appear in the final
 * prompt.
 */
export function renderWorkspaceSections(ctx: SectionRenderContext): string[] {
  const dir = getWorkspaceSystemPromptDir();
  if (!existsSync(dir)) {
    log.debug({ dir }, "Workspace system prompt directory missing");
    return [];
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    log.warn({ err, dir }, "Failed to list workspace system prompt dir");
    return [];
  }

  const ids = entries
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -".md".length))
    .sort();

  const out: string[] = [];
  for (const id of ids) {
    const rendered = renderSection(id, ctx);
    if (rendered) out.push(rendered);
  }
  return out;
}

function renderSection(id: string, ctx: SectionRenderContext): string | null {
  const path = join(getWorkspaceSystemPromptDir(), `${id}.md`);

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    log.warn({ err, path }, "Failed to read system prompt section");
    return null;
  }

  const parsed = parseFrontmatterFields(raw);
  const fields = parsed?.fields ?? {};
  const body = parsed?.body ?? raw;

  if (!isEnabled(fields["enabled"], ctx)) return null;

  const stripped = stripCommentLines(body).trim();
  if (stripped.length === 0) return null;
  return interpolateVariables(stripped, ctx);
}

const IDENT_REGEX = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Apply mustache-style interpolation to `body` against `ctx`, in this order:
 *
 *   1. **Standalone-tag normalization.** A section open/close tag occupying
 *      its own line (only whitespace on either side) absorbs the trailing
 *      newline.  This lets authors write block-style templates without
 *      orphan blank lines bleeding through into the rendered output.
 *   2. **Sections** — `{{#flag}}body{{/flag}}` renders `body` when
 *      `ctx[flag]` is truthy, empty otherwise.  **Inverted sections** —
 *      `{{^flag}}body{{/flag}}` — render the opposite.  The close tag's
 *      name must match the open tag's; bodies are matched non-greedily so
 *      sibling sections stay independent.  Nested same-named sections are
 *      *not* supported (no use case yet).
 *   3. **Variables** — `{{key}}` substitutes `String(ctx[key])`.
 *
 * Section *keys* are valid JS identifiers (`[A-Za-z_$][A-Za-z0-9_$]*`) so
 * the construct can't be confused with code-block braces in the markdown.
 * Section keys whose `ctx` value is `undefined` leave the entire construct
 * as a literal — this surfaces author typos at the warn log instead of
 * silently swallowing the body.  Variable keys whose `ctx` value is
 * `undefined` or `null` likewise stay literal.  `null` and `false` as
 * section values are treated as falsy (so callers can pass through
 * runtime gates without normalizing to plain booleans first).
 */
function interpolateVariables(
  body: string,
  ctx: SectionRenderContext,
): string {
  // Collapse standalone tag lines so multiline section templates render
  // without phantom blank lines from the layout markers.
  const collapsed = body.replace(STANDALONE_TAG_LINE, "$1");

  // Evaluate `{{#flag}}` / `{{^flag}}` blocks before variables, so a
  // section body may itself contain `{{var}}` substitutions.
  const sectionsResolved = collapsed.replace(
    SECTION,
    (match, kind: string, key: string, sectionBody: string) => {
      const value = ctx[key];
      if (value === undefined) {
        log.warn(
          { key, kind },
          "Unresolved {{#section}} key in workspace system prompt; leaving literal",
        );
        return match;
      }
      const truthy = Boolean(value);
      const include = kind === "#" ? truthy : !truthy;
      return include ? sectionBody : "";
    },
  );

  return sectionsResolved.replace(VARIABLE, (match, key: string) => {
    const value = ctx[key];
    if (value === undefined || value === null) {
      log.warn(
        { key },
        "Unresolved {{variable}} in workspace system prompt section; leaving literal",
      );
      return match;
    }
    return String(value);
  });
}

const IDENT_PATTERN = "[A-Za-z_$][A-Za-z0-9_$]*";

/**
 * Matches a section open/close tag that sits alone on its line (optional
 * whitespace on either side, followed by a line terminator or end of
 * input).  The replacement keeps the tag itself and discards the
 * surrounding whitespace + newline.
 */
const STANDALONE_TAG_LINE = new RegExp(
  `^[ \\t]*(\\{\\{[#^/]${IDENT_PATTERN}\\}\\})[ \\t]*(?:\\r?\\n|$)`,
  "gm",
);

/**
 * Matches a section block `{{#name}}body{{/name}}` or its inverted form
 * `{{^name}}body{{/name}}`.  The backreference forces the close tag to
 * name the same key as the open tag; `[\s\S]*?` lets the body span
 * multiple lines without greedy-matching across sibling sections.
 */
const SECTION = new RegExp(
  `\\{\\{([#^])(${IDENT_PATTERN})\\}\\}([\\s\\S]*?)\\{\\{\\/\\2\\}\\}`,
  "g",
);

const VARIABLE = new RegExp(`\\{\\{(${IDENT_PATTERN})\\}\\}`, "g");

/**
 * Evaluate an `enabled:` frontmatter value.  Supported shapes:
 *
 *   - omitted / undefined  → always enabled
 *   - boolean              → use as-is
 *   - `<key>`              → render when `ctx[key]` is truthy
 *   - `!<key>`             → render when `ctx[key]` is falsy
 *
 * Predicate forms are intentionally limited to a single identifier (with
 * optional leading `!`).  Anything more elaborate is rejected so the
 * frontmatter stays declarative — if a section needs richer logic, route
 * a pre-computed boolean through the context map and reference that.
 */
function isEnabled(value: unknown, ctx: SectionRenderContext): boolean {
  if (value === undefined) return true;
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") {
    log.warn(
      { value },
      "Unsupported `enabled` type in section frontmatter; treating as disabled",
    );
    return false;
  }

  let trimmed = value.trim();
  if (trimmed.length === 0) return true;

  let negate = false;
  if (trimmed.startsWith("!")) {
    negate = true;
    trimmed = trimmed.slice(1).trim();
  }

  if (!IDENT_REGEX.test(trimmed)) {
    log.warn(
      { value },
      "Unsupported `enabled` expression in section frontmatter; treating as disabled",
    );
    return false;
  }

  const result = Boolean(ctx[trimmed]);
  return negate ? !result : result;
}
