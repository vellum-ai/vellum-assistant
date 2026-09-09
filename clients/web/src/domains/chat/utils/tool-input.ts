/**
 * Reading identifier-ish strings out of a tool call's input bag.
 *
 * A tool's input is whatever the model sent, and the same field reaches us
 * under more than one spelling: a path arrives as `file_path`, `path` or
 * `filePath`, a shell command as `command` or the legacy `cmd`. Every surface
 * that shows one has to accept the whole set or it renders blank for calls the
 * chip beside it renders fine.
 */

/**
 * First non-blank string among `keys`, trimmed, or `""` when none is set.
 *
 * Trimming suits identifiers (a path, a command, a query), which is all this is
 * for. Content whose whitespace is load-bearing (an edit's `old_string`) must
 * be read raw instead, since a whitespace-only value is real content and would
 * come back from here as absent.
 */
export function readToolInputString(
  input: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

/**
 * Spellings a file path arrives under.
 *
 * `path` is canonical: the daemon's alias table rewrites `file_path` to it for
 * every aliased filesystem tool (`assistant/src/tools/tool-name-aliases.ts`).
 * A model calling a canonically-named tool directly can still send `file_path`,
 * which is why the daemon's own summariser reads both, and `filePath` reaches
 * us from callers that camel-case everything. Order does not decide anything:
 * the rewrite deletes the key it renames, so no call carries two of these.
 */
export const FILE_PATH_KEYS = ["file_path", "path", "filePath"] as const;

/** Spellings a shell command arrives under; `cmd` is the legacy one. */
export const COMMAND_KEYS = ["command", "cmd"] as const;

/**
 * Spellings of the activity sentence the daemon attaches to an input, mirroring
 * macOS `reasonDescription`; `reason` is the legacy one.
 */
export const ACTIVITY_KEYS = ["activity", "reason"] as const;
