import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatterFields } from "../skills/frontmatter.js";
import { resolveBundledDir } from "../util/bundled-asset.js";
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
 * Workspace override location for user-authored system prompt sections.
 * Layout: `<workspace>/prompts/system/<NN-name>.md`.
 *
 * Bundled `templates/system/` files are the source of default truth; this
 * directory is an optional override layer.  Drop a file with the same
 * filename as a bundled section to replace its body, or drop a file with
 * a new `<NN-name>` to add a workspace-only section.  Either path is
 * opt-in — the directory may not exist on a fresh install.
 */
export function getWorkspaceSystemPromptDir(): string {
  return join(getWorkspaceDir(), "prompts", "system");
}

/**
 * Bundled location for the default system prompt sections shipped with
 * the daemon.  The renderer reads from here unless the workspace has a
 * file with the same name, in which case the workspace file wins.
 *
 * Resolved through `resolveBundledDir` so it works in both source builds
 * (relative to `prompts/`) and packaged bun binaries (macOS .app Resources
 * dir or alongside the binary).
 */
export function getBundledSystemPromptDir(): string {
  const callerDir = import.meta.dirname ?? __dirname;
  return join(resolveBundledDir(callerDir, "templates", "templates"), "system");
}

/**
 * Render every section in filename order, returning the trimmed body of
 * each enabled section.  Discovery walks both `<bundled>/templates/system/`
 * and `<workspace>/prompts/system/` and takes the union of section ids.
 *
 * Resolution per id:
 *   - workspace file present → use workspace body (override)
 *   - workspace file absent  → use bundled body (default)
 *
 * Bundled is the source of default truth.  Workspace acts as an override
 * layer — a user can replace a bundled section by writing the same
 * filename in their workspace, or add a brand-new section by writing a
 * filename that doesn't exist in bundled.  The workspace directory does
 * not need to exist on a fresh install; the renderer will fall through to
 * bundled-only.
 *
 * Render contract per section:
 *   1. resolve path (workspace wins over bundled)
 *   2. parse YAML frontmatter (optional); body is everything after
 *   3. evaluate `enabled` against `ctx`; falsy → skip
 *   4. strip lines starting with `_` (legacy inline-comment convention)
 *   5. trim; emit if non-empty, otherwise skip
 *
 * The empty-body case is intentional — a user can silence a bundled
 * section by overriding it with a file that strips down to nothing
 * (frontmatter `enabled: false`, or a frontmatter-only file, or a body
 * of only `_`-comments).  This is the supported "disable a bundled
 * default" path.
 *
 * The numeric prefix is load-bearing for sort order; pick a number that
 * places the section where it should appear in the final prompt.
 */
export function renderWorkspaceSections(ctx: SectionRenderContext): string[] {
  const bundledDir = getBundledSystemPromptDir();
  const workspaceDir = getWorkspaceSystemPromptDir();

  const ids = collectSectionIds(bundledDir, workspaceDir);

  const out: string[] = [];
  for (const id of ids) {
    const rendered = renderSection(id, ctx, bundledDir, workspaceDir);
    if (rendered) out.push(rendered);
  }
  return out;
}

function collectSectionIds(
  bundledDir: string,
  workspaceDir: string,
): string[] {
  const ids = new Set<string>();
  for (const dir of [bundledDir, workspaceDir]) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (err) {
      log.warn({ err, dir }, "Failed to list system prompt directory");
      continue;
    }
    for (const name of entries) {
      if (name.endsWith(".md")) ids.add(name.slice(0, -".md".length));
    }
  }
  return [...ids].sort();
}

function renderSection(
  id: string,
  ctx: SectionRenderContext,
  bundledDir: string,
  workspaceDir: string,
): string | null {
  const workspacePath = join(workspaceDir, `${id}.md`);
  const bundledPath = join(bundledDir, `${id}.md`);
  const path = existsSync(workspacePath) ? workspacePath : bundledPath;

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
