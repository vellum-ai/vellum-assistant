type ToolInputNormalizer = (
  input: Record<string, unknown>,
) => Record<string, unknown>;

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
]);

/**
 * Resolve high-confidence compatibility aliases before active-tool gating.
 * Keep this list narrow: aliases should only cover observed model drift where
 * the canonical target is active for the turn.
 */
export function resolveToolNameAlias(
  name: string,
  allowedToolNames?: ReadonlySet<string>,
): string {
  if (allowedToolNames?.has(name)) return name;
  const alias = TOOL_NAME_ALIASES.get(name);
  if (!alias) return name;
  if (allowedToolNames && !allowedToolNames.has(alias.canonicalName))
    return name;
  return alias.canonicalName;
}

export function resolveToolInvocationAlias(
  name: string,
  input: Record<string, unknown>,
  allowedToolNames?: ReadonlySet<string>,
): { name: string; input: Record<string, unknown> } {
  if (allowedToolNames?.has(name)) return { name, input };
  const alias = TOOL_NAME_ALIASES.get(name);
  if (!alias) return { name, input };
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
