import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatterFields } from "../skills/frontmatter.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir, getWorkspacePromptPath } from "../util/platform.js";
import { stripCommentLines } from "../util/strip-comment-lines.js";
import {
  BUNDLED_SYSTEM_SECTIONS,
  type BundledSection,
} from "./templates/system-sections.js";

const log = getLogger("system-prompt-sections");

/**
 * Render context passed by the caller of `renderWorkspaceSections`. Sections
 * declare their `enabled` predicate as a context key (or `!key`), and the
 * predicate is evaluated against fields on this object.
 *
 * Intentionally an open record — the registry never references specific keys.
 * Callers (currently `buildSystemPrompt`) hand in the same options object
 * they received, so any field on `BuildSystemPromptOptions` can be
 * referenced by name in a section's `enabled` predicate or `{{variable}}`
 * interpolation.
 */
export type SectionRenderContext = Record<string, unknown>;

/**
 * Workspace override location for user-authored system prompt sections.
 * Layout: `<workspace>/prompts/system/<NN-name>.md`.
 *
 * The bundled section registry (`templates/system-sections.ts`) is the
 * source of default truth; this directory is an optional override layer.
 * Drop a file with the same id as a bundled section to replace its body,
 * or drop a file with a brand-new `<NN-name>` to add a workspace-only
 * section.  Either path is opt-in — the directory may not exist on a
 * fresh install, and the renderer will simply use bundled defaults.
 */
export function getWorkspaceSystemPromptDir(): string {
  return join(getWorkspaceDir(), "prompts", "system");
}

/**
 * Render static sections in id-sort order, then dynamic sections in id-sort
 * order, returning the trimmed bodies of enabled sections grouped into
 * cache blocks. Discovery walks the bundled registry plus any `.md` files
 * in the workspace override dir, and takes the union of ids.
 *
 * Resolution per id:
 *   - workspace `.md` file present → use workspace body (override)
 *   - workspace file absent        → use bundled registry entry (default)
 *
 * Bundled is the source of default truth.  Workspace acts as an override
 * layer — a user can replace a bundled section by writing the same id in
 * their workspace, or add a brand-new section by writing an id that
 * doesn't appear in the bundled registry.  Workspace-only ids skip the
 * bundled lookup entirely.
 *
 * Render contract per section:
 *   1. resolve `{ enabled, body }` (workspace .md wins over bundled TS)
 *   2. evaluate `enabled` against `ctx`; falsy → skip
 *   3. apply mustache section / inverted-section / variable interpolation
 *   4. strip lines starting with `_` (legacy inline-comment convention)
 *   5. trim; emit if non-empty, otherwise skip
 *
 * The empty-body case is intentional — a user can silence a bundled
 * section by overriding it with a file that strips down to nothing
 * (frontmatter `enabled: false`, or a frontmatter-only file, or a body
 * of only `_`-comments).  This is the supported "disable a bundled
 * default" path.
 *
 * Cache blocks: a section may declare a cache breakpoint (bundled
 * `cacheBreakpoint` field, or frontmatter `cache_breakpoint: true` on a
 * workspace file).  The breakpoint ends the current block *after* that
 * section's position in the id ordering — the split happens even when the
 * declaring section itself gates off, so a disabled section doesn't
 * silently merge the blocks around it.  Only the first breakpoint is
 * honored (the provider-side cache budget allows exactly two system
 * blocks); extras are logged and ignored.
 *
 * The numeric prefix on each id is load-bearing inside its render phase; pick
 * a number that places the section where it should appear in the final prompt.
 */
export function renderWorkspaceSections(ctx: SectionRenderContext): string[][] {
  const workspaceDir = getWorkspaceSystemPromptDir();
  const ids = collectSectionIds(workspaceDir);

  const blocks: string[][] = [[]];
  let breakpointPlaced = false;
  for (const id of ids) {
    const section = resolveSection(id, ctx, workspaceDir);
    if (section === null) continue;
    const rendered = renderResolvedSection(section, ctx);
    if (rendered) blocks[blocks.length - 1].push(rendered);
    if (section.cacheBreakpoint) {
      if (breakpointPlaced) {
        log.warn(
          { id },
          "Multiple cache_breakpoint declarations; only the first is honored",
        );
      } else {
        breakpointPlaced = true;
        blocks.push([]);
      }
    }
  }
  return blocks;
}

function collectSectionIds(workspaceDir: string): string[] {
  const ids = new Set<string>();
  for (const section of BUNDLED_SYSTEM_SECTIONS) ids.add(section.id);
  if (existsSync(workspaceDir)) {
    try {
      for (const name of readdirSync(workspaceDir)) {
        if (name.endsWith(".md")) ids.add(name.slice(0, -".md".length));
      }
    } catch (err) {
      log.warn(
        { err, workspaceDir },
        "Failed to list workspace system prompt dir",
      );
    }
  }
  return [...ids].sort(compareSectionIds);
}

function compareSectionIds(a: string, b: string): number {
  const aDynamic = isDynamicSectionId(a);
  const bDynamic = isDynamicSectionId(b);
  if (aDynamic !== bDynamic) return aDynamic ? 1 : -1;
  return a.localeCompare(b);
}

function isDynamicSectionId(id: string): boolean {
  return BUNDLED_SYSTEM_SECTIONS.some(
    (section) => section.id === id && section.dynamic === true,
  );
}

interface ResolvedSection {
  enabled: string | boolean | undefined;
  body: string;
  cacheBreakpoint: boolean;
  transform?: BundledSection["transform"];
}

function resolveSection(
  id: string,
  ctx: SectionRenderContext,
  workspaceDir: string,
): ResolvedSection | null {
  const workspacePath = join(workspaceDir, `${id}.md`);
  if (existsSync(workspacePath)) {
    let raw: string;
    try {
      raw = readFileSync(workspacePath, "utf-8");
    } catch (err) {
      log.warn(
        { err, workspacePath },
        "Failed to read workspace section override",
      );
      return null;
    }
    const parsed = parseFrontmatterFields(raw);
    const fields = parsed?.fields ?? {};
    const body = parsed?.body ?? raw;
    // Workspace override skips the bundled transform: when the user has
    // written their own `prompts/system/<id>.md` they've taken full
    // control of the body shape, and re-running the bundled transform
    // (e.g. unmodified-template detection on IDENTITY.md) would
    // misclassify their override.  The same applies to cache-breakpoint
    // placement: the override's frontmatter is the sole source of truth,
    // so an override without `cache_breakpoint` clears a bundled
    // declaration.
    return {
      enabled: fields["enabled"] as string | boolean | undefined,
      body,
      cacheBreakpoint: fields["cache_breakpoint"] === true,
    };
  }
  const bundled = BUNDLED_SYSTEM_SECTIONS.find((s) => s.id === id);
  if (!bundled) return null;

  // A bundled section may delegate its body to a workspace file outside
  // the section override directory (e.g. `SOUL.md` at the workspace
  // root).  `workspacePath` may be a single path or an array of paths
  // tried in order — the first one whose file exists and has non-empty
  // content wins.  Each entry may reference `{{ctx-key}}` variables
  // (e.g. `users/{{userSlug}}.md`) that are interpolated against the
  // render context before resolution.  Missing/empty files yield "",
  // which `renderSection` then gates off via its empty-body check (or
  // via the section's `transform`, if set).
  if (bundled.workspacePath) {
    const paths = Array.isArray(bundled.workspacePath)
      ? bundled.workspacePath
      : [bundled.workspacePath];
    let body = "";
    for (const pathTemplate of paths) {
      const interpolated = interpolateWorkspacePath(pathTemplate, ctx);
      const filePath = getWorkspacePromptPath(interpolated);
      if (!existsSync(filePath)) continue;
      try {
        const content = readFileSync(filePath, "utf-8");
        if (content.trim().length > 0) {
          body = content;
          break;
        }
      } catch (err) {
        log.warn({ err, filePath, id }, "Failed to read section workspacePath");
      }
    }
    return {
      enabled: bundled.enabled,
      body,
      cacheBreakpoint: bundled.cacheBreakpoint === true,
      transform: bundled.transform,
    };
  }

  return {
    enabled: bundled.enabled,
    body: bundled.body,
    cacheBreakpoint: bundled.cacheBreakpoint === true,
    transform: bundled.transform,
  };
}

/**
 * Interpolate `{{key}}` references in a workspace-path template against
 * `ctx`. Section / inverted-section tags are not supported in paths —
 * only flat variable substitution. Unresolved keys stay literal so a
 * typo surfaces as a missing file rather than silently rendering an
 * unrelated section.
 */
function interpolateWorkspacePath(
  template: string,
  ctx: SectionRenderContext,
): string {
  return template.replace(VARIABLE, (match, key: string) => {
    const value = ctx[key];
    if (value === undefined || value === null) return match;
    return String(value);
  });
}

function renderResolvedSection(
  section: ResolvedSection,
  ctx: SectionRenderContext,
): string | null {
  if (!isEnabled(section.enabled, ctx)) return null;

  let body = section.body;
  if (section.transform) {
    const transformed = section.transform(body, ctx);
    if (transformed === null) return null;
    body = transformed;
  }

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
 * Section keys are coerced via `Boolean(ctx[key])` — `undefined`, `null`,
 * `false`, `0`, and `""` all gate the body off; everything else gates it
 * on.  This means callers can pass through optional flags without
 * normalizing each one to a defined boolean first.  **Variable** keys
 * whose `ctx` value is `undefined` or `null` stay literal (so an authoring
 * typo on a `{{key}}` substitution surfaces at the warn log rather than
 * inlining the string `"undefined"`).
 */
function interpolateVariables(body: string, ctx: SectionRenderContext): string {
  // Collapse standalone tag lines so multiline section templates render
  // without phantom blank lines from the layout markers.
  const collapsed = body.replace(STANDALONE_TAG_LINE, "$1");

  // Evaluate `{{#flag}}` / `{{^flag}}` blocks before variables, so a
  // section body may itself contain `{{var}}` substitutions.  Section
  // keys are pure gates — the body is either in or out, never inlined —
  // so we treat any falsy value (including `undefined`) as "gate off"
  // rather than surfacing typos.  This keeps optional `BuildSystemPromptOptions`
  // flags working when the caller omits them.
  const sectionsResolved = collapsed.replace(
    SECTION,
    (_match, kind: string, key: string, sectionBody: string) => {
      const truthy = Boolean(ctx[key]);
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
 * Evaluate an `enabled:` predicate.  Supported shapes:
 *
 *   - omitted / undefined  → always enabled
 *   - boolean              → use as-is
 *   - `<key>`              → render when `ctx[key]` is truthy
 *   - `!<key>`             → render when `ctx[key]` is falsy
 *
 * Predicate forms are intentionally limited to a single identifier (with
 * optional leading `!`).  Anything more elaborate is rejected so the
 * predicate stays declarative — if a section needs richer logic, route a
 * pre-computed boolean through the context map and reference that.
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

// Re-export the registry type so callers (rare) can introspect bundled
// content without reaching into the templates directory directly.
export type { BundledSection };
