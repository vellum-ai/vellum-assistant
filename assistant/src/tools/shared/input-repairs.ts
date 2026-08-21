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

interface ToolInputRepairRules {
  /**
   * Parameter spellings the tool accepts as another parameter's name.
   *
   * Each entry is a name the prose around the tool uses for a parameter the
   * schema declares under a different one, and models follow prose over
   * schema. `scaffold_managed_skill` declares `body_markdown` while the
   * skill-authoring prose talks throughout about writing "the body"; the
   * retrospective prompt tells the model to call `find_similar_skills` with a
   * short description, which the schema declares as `goal`.
   *
   * An alias applies only when the canonical parameter is absent, so a call
   * that spells the parameter correctly is never overwritten.
   */
  aliases?: Readonly<Record<string, string>>;
  /** Whether the tool's `files` parameter also reads a path-keyed map. */
  filesMap?: boolean;
}

const REPAIR_RULES: Readonly<Record<string, ToolInputRepairRules>> = {
  scaffold_managed_skill: {
    aliases: {
      body: "body_markdown",
      content: "body_markdown",
      title: "name",
      summary: "description",
    },
    filesMap: true,
  },
  find_similar_skills: {
    aliases: { description: "goal", query: "goal" },
  },
};

/** The properties one `files` entry declares. */
const FILE_ENTRY_KEYS: ReadonlySet<string> = new Set([
  "path",
  "content",
  "copy_from",
]);

/** The properties a `files` entry may carry besides its path. */
const FILE_BYTES_KEYS: ReadonlySet<string> = new Set(["content", "copy_from"]);

/**
 * Read a `files` object written as a map from path to contents, the shape
 * models reach for when asked for companion files keyed by where they go:
 * `{"references/failure-modes.md": "..."}`, or with the entry spelled out as
 * `{"scripts/run.sh": {"copy_from": "/abs/path"}}`.
 *
 * Returns the declared array shape, or `undefined` when any entry is not
 * readable as one file, in which case the whole value is left alone: a partial
 * reading would drop files the caller asked for without saying so. Guessing
 * which path wins for an entry that names its own is a guess about intent
 * rather than a repair, so those are left too.
 */
function filesMapToEntries(
  map: Record<string, unknown>,
): unknown[] | undefined {
  const entries = Object.entries(map);
  // An object spelling out one entry's own fields is a single file, not a map
  // of them. Reading it as a map would turn its field names into paths.
  if (
    entries.length === 0 ||
    entries.every(([key]) => FILE_ENTRY_KEYS.has(key))
  ) {
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
    if (!isPlainObject(entry)) {
      return undefined;
    }
    const keys = Object.keys(entry);
    if (keys.length === 0 || !keys.every((key) => FILE_BYTES_KEYS.has(key))) {
      return undefined;
    }
    files.push({ path, ...entry });
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
  const rules = REPAIR_RULES[toolName];
  if (!rules) {
    return input;
  }
  let repaired: Record<string, unknown> | undefined;

  for (const [alias, canonical] of Object.entries(rules.aliases ?? {})) {
    if (!(alias in input) || canonical in input) {
      continue;
    }
    repaired ??= { ...input };
    repaired[canonical] = repaired[alias];
    delete repaired[alias];
  }

  const files = input.files;
  if (rules.filesMap && isPlainObject(files)) {
    const entries = filesMapToEntries(files);
    if (entries) {
      repaired ??= { ...input };
      repaired.files = entries;
    }
  }

  return repaired ?? input;
}

/** Every alias a bundled `toolName` accepts, for drift guards. */
export function bundledToolInputAliases(toolName: string): string[] {
  return Object.keys(REPAIR_RULES[toolName]?.aliases ?? {});
}
