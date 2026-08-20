/**
 * Pre-validation repairs for bundled tool calls whose arguments arrive in a
 * shape the tool did not declare but whose intent is unambiguous.
 *
 * The sibling module `input-misuse.ts` answers a misused parameter shape with
 * a better error message. This one answers the shapes we can act on instead:
 * the call carries what the tool needs, spelled the way the surrounding prose
 * asks for it rather than the way the schema declares it, so rewriting it is
 * closer to the caller's intent than rejecting it. Repairs run before
 * `validateInputAgainstSchema`, so a repaired call validates on its merits and
 * anything left unrepaired keeps its normal error.
 *
 * Generic, schema-derivable coercions (a string holding a JSON array, one
 * element where a list was expected) belong in `skills/validate-input.ts`.
 * What lives here is knowledge of a specific tool's contract that no schema
 * states.
 *
 * Rules describe the first-party tools that ship in `bundled-skills/`, and
 * tool names are not reserved: a managed, workspace, extra, or plugin skill
 * may define its own `scaffold_managed_skill` with a different contract. The
 * `bundled` prefix on the export is the reminder that callers must establish
 * bundled provenance before applying a repair.
 */

import { isPlainObject } from "../../util/object.js";

/**
 * Parameter spellings a tool accepts as another parameter's name.
 *
 * `scaffold_managed_skill` declares `body_markdown`, while the skill-authoring
 * prose that drives the call talks throughout about writing "the body" (see
 * `bundled-skills/skill-management/SKILL.md` and the memory retrospective's
 * prompt). A model that follows the prose sends `body`, and the value it sends
 * is the skill body the tool wants.
 *
 * An alias applies only when the canonical parameter is absent, so a call that
 * spells the parameter correctly is never overwritten.
 */
const PARAMETER_ALIASES: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  scaffold_managed_skill: { body: "body_markdown" },
};

/** Tools whose `files` parameter accepts a path-keyed map (see below). */
const FILES_MAP_TOOLS: ReadonlySet<string> = new Set([
  "scaffold_managed_skill",
]);

/** The properties one `files` entry declares. */
const FILE_ENTRY_KEYS: ReadonlySet<string> = new Set([
  "path",
  "content",
  "copy_from",
]);

/**
 * Read a `files` object written as a map from path to contents, the shape
 * models reach for when asked for companion files keyed by where they go:
 * `{"references/failure-modes.md": "..."}`, or with the entry spelled out as
 * `{"scripts/run.sh": {"copy_from": "/abs/path"}}`.
 *
 * Returns the declared array shape, or `undefined` when any entry is not
 * readable as one file, in which case the whole value is left alone: a partial
 * reading would drop files the caller asked for without saying so.
 */
function filesMapToEntries(value: unknown): unknown[] | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return undefined;
  }
  // An object spelling out one entry's own fields is a single file, not a map
  // of them. Reading it as a map would turn its field names into paths.
  if (entries.every(([key]) => FILE_ENTRY_KEYS.has(key))) {
    return undefined;
  }
  const files: Record<string, unknown>[] = [];
  for (const [path, entry] of entries) {
    if (!path.trim()) {
      return undefined;
    }
    if (typeof entry === "string") {
      files.push({ path, content: entry });
      continue;
    }
    // Only an entry that carries nothing but the file's bytes is readable as
    // a map value. Anything else (including an entry naming its own `path`)
    // is a different shape, and guessing which path wins would be a guess
    // about intent rather than a repair.
    const keys = isPlainObject(entry) ? Object.keys(entry) : [];
    if (
      keys.length === 0 ||
      !keys.every((key) => key === "content" || key === "copy_from")
    ) {
      return undefined;
    }
    files.push({ path, ...(entry as Record<string, unknown>) });
  }
  return files;
}

/**
 * Rewrite a bundled tool's input into the shape its schema declares, when the
 * arguments say what was meant unambiguously.
 *
 * Only call this for a tool that came from a bundled skill. `toolName` alone
 * does not establish that.
 *
 * Pure: returns a new object when a repair applies, otherwise returns `input`
 * unchanged. Never mutates `input`.
 */
export function bundledToolInputRepairs(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  let repaired: Record<string, unknown> | undefined;

  const aliases = PARAMETER_ALIASES[toolName];
  if (aliases) {
    for (const [alias, canonical] of Object.entries(aliases)) {
      if (!(alias in input) || canonical in input) {
        continue;
      }
      repaired ??= { ...input };
      repaired[canonical] = repaired[alias];
      delete repaired[alias];
    }
  }

  if (FILES_MAP_TOOLS.has(toolName)) {
    const source = repaired ?? input;
    const files = source.files;
    if (!Array.isArray(files) && isPlainObject(files)) {
      const entries = filesMapToEntries(files);
      if (entries) {
        repaired ??= { ...input };
        repaired.files = entries;
      }
    }
  }

  return repaired ?? input;
}

/** Every alias a bundled `toolName` accepts, for drift guards. */
export function bundledToolInputAliases(toolName: string): string[] {
  return Object.keys(PARAMETER_ALIASES[toolName] ?? {});
}
