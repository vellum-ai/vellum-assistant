const TOOL_NAME_ALIASES = new Map<string, string>([
  ["create_app", "app_create"],
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
  const canonical = TOOL_NAME_ALIASES.get(name);
  if (!canonical) return name;
  if (allowedToolNames && !allowedToolNames.has(canonical)) return name;
  return canonical;
}
