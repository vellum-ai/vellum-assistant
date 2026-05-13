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
 * Inclusive numeric range applied to section ids.  Range bounds compare
 * against the leading integer in each id (`"03-cli-reference"` → `3`).
 * Used by `buildSystemPrompt` to bracket the still-code-rendered middle
 * sections during incremental migration; once every section lives in the
 * workspace the caller can drop the range and emit the whole directory in
 * one shot.
 */
export interface RenderRange {
  /** Inclusive lower bound on numeric prefix (e.g. `"03"` or `3`). */
  from?: string | number;
  /** Inclusive upper bound on numeric prefix (e.g. `"04"` or `4`). */
  to?: string | number;
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
 *
 * When `range` is provided, only sections whose numeric prefix falls within
 * the inclusive bounds are emitted.  Files without a leading integer prefix
 * are skipped entirely when a range filter is active.
 */
export function renderWorkspaceSections(
  ctx: SectionRenderContext,
  range?: RenderRange,
): string[] {
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
    .filter((id) => withinRange(id, range))
    .sort();

  const out: string[] = [];
  for (const id of ids) {
    const rendered = renderSection(id, ctx);
    if (rendered) out.push(rendered);
  }
  return out;
}

function withinRange(id: string, range: RenderRange | undefined): boolean {
  if (!range) return true;
  const match = id.match(/^(\d+)/);
  if (!match) return false;
  const n = Number.parseInt(match[1]!, 10);
  if (range.from !== undefined && n < toNumber(range.from)) return false;
  if (range.to !== undefined && n > toNumber(range.to)) return false;
  return true;
}

function toNumber(value: string | number): number {
  if (typeof value === "number") return value;
  return Number.parseInt(value, 10);
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
  return stripped;
}

const IDENT_REGEX = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

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
