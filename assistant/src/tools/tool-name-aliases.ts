import { levenshtein } from "./filesystem/fuzzy-match.js";

type ToolInputNormalizer = (
  input: Record<string, unknown>,
) => Record<string, unknown>;

/**
 * Return a normalizer that renames input key `from` to `to`, translating the
 * arg-key convention an alias is typically called with. A no-op when `from`
 * is absent or `to` is already present, so inputs that already match the
 * canonical schema pass through untouched.
 */
function renameInputKey(from: string, to: string): ToolInputNormalizer {
  return (input) => {
    if (!(from in input) || to in input) {
      return input;
    }
    const { [from]: value, ...rest } = input;
    return { ...rest, [to]: value };
  };
}

/**
 * Tool names models commonly invent, mapped to the canonical tool. An alias
 * is only rewritten when the canonical tool is active for the turn and the
 * requested name is not (see {@link resolveToolInvocationAlias}), so a live
 * tool that happens to carry an aliased name always wins. Keep entries to
 * unambiguous 1:1 semantics — a name whose intent could map to several tools
 * belongs in {@link suggestToolName} territory instead, where the model
 * re-decides with the real list.
 */
const TOOL_NAME_ALIASES = new Map<
  string,
  { canonicalName: string; normalizeInput?: ToolInputNormalizer }
>([
  ["create_app", { canonicalName: "app_create" }],
  [
    "computer_use_press_key",
    {
      canonicalName: "computer_use_key",
      normalizeInput: normalizeLegacyComputerUsePressKeyInput,
    },
  ],
  // Filesystem reads — Claude-Code-style and unix-style names.
  [
    "read_file",
    {
      canonicalName: "file_read",
      normalizeInput: renameInputKey("file_path", "path"),
    },
  ],
  [
    "read",
    {
      canonicalName: "file_read",
      normalizeInput: renameInputKey("file_path", "path"),
    },
  ],
  [
    "cat",
    {
      canonicalName: "file_read",
      normalizeInput: renameInputKey("file_path", "path"),
    },
  ],
  [
    "fs_read",
    {
      canonicalName: "file_read",
      normalizeInput: renameInputKey("file_path", "path"),
    },
  ],
  [
    "workspace_read",
    {
      canonicalName: "file_read",
      normalizeInput: renameInputKey("file_path", "path"),
    },
  ],
  // Directory listings.
  [
    "list_files",
    {
      canonicalName: "file_list",
      normalizeInput: renameInputKey("directory", "path"),
    },
  ],
  [
    "list_directory",
    {
      canonicalName: "file_list",
      normalizeInput: renameInputKey("directory", "path"),
    },
  ],
  // Shell execution.
  [
    "shell",
    {
      canonicalName: "bash",
      normalizeInput: renameInputKey("cmd", "command"),
    },
  ],
  [
    "exec",
    {
      canonicalName: "bash",
      normalizeInput: renameInputKey("cmd", "command"),
    },
  ],
]);

/**
 * Suggest the closest known tool name for an unknown one, for a
 * `Did you mean "…"?` hint. Two conservative signals:
 *
 * - underscore-token permutations (`file_read` for `read_file`), which pure
 *   edit distance misses, and
 * - edit distance ≤ 2, catching typos without misdirecting semantically
 *   different names (`task_create` must NOT suggest `app_create`).
 *
 * Ties resolve to the smallest distance, then lexicographically, so the
 * suggestion is deterministic. Returns `undefined` when nothing is close.
 */
export function suggestToolName(
  name: string,
  candidates: Iterable<string>,
): string | undefined {
  const tokenKey = (value: string): string =>
    value.toLowerCase().split(/[_-]/).filter(Boolean).sort().join("_");
  const nameKey = tokenKey(name);

  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    if (candidate === name) {
      continue;
    }
    const distance =
      tokenKey(candidate) === nameKey ? 0 : levenshtein(name, candidate);
    if (distance > 2) {
      continue;
    }
    if (
      distance < bestDistance ||
      (distance === bestDistance && best !== undefined && candidate < best)
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

export function resolveToolInvocationAlias(
  name: string,
  input: Record<string, unknown>,
  allowedToolNames?: ReadonlySet<string>,
): { name: string; input: Record<string, unknown> } {
  if (allowedToolNames?.has(name)) {
    return { name, input };
  }
  const alias = TOOL_NAME_ALIASES.get(name);
  if (!alias) {
    return { name, input };
  }
  if (allowedToolNames && !allowedToolNames.has(alias.canonicalName)) {
    return { name, input };
  }
  return {
    name: alias.canonicalName,
    input: alias.normalizeInput ? alias.normalizeInput(input) : input,
  };
}

function normalizeLegacyComputerUsePressKeyInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...input };
  const key = typeof normalized.key === "string" ? normalized.key.trim() : "";
  const modifiers = Array.isArray(normalized.modifiers)
    ? normalized.modifiers.flatMap((modifier) => {
        if (typeof modifier !== "string") return [];
        const normalizedModifier = normalizeKeyModifier(modifier);
        return normalizedModifier ? [normalizedModifier] : [];
      })
    : [];

  delete normalized.modifiers;

  if (key && modifiers.length > 0 && !key.includes("+")) {
    normalized.key = [...new Set(modifiers), key.toLowerCase()].join("+");
  } else if (key && !key.includes("+")) {
    normalized.key = key.toLowerCase();
  }

  return normalized;
}

function normalizeKeyModifier(modifier: string): string | undefined {
  switch (modifier.trim().toLowerCase()) {
    case "cmd":
    case "command":
    case "meta":
      return "cmd";
    case "ctrl":
    case "control":
      return "ctrl";
    case "option":
    case "alt":
      return "option";
    case "shift":
      return "shift";
    default:
      return undefined;
  }
}
