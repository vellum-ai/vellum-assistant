/**
 * Presentation ordering for inference profiles. `llm.profileOrder` lists the
 * keys a workspace wants surfaced first; the resolver ignores it, so it exists
 * purely to keep profile pickers consistent across surfaces.
 */

/**
 * Order profile keys for presentation: keys named in `profileOrder` first
 * (deduped, and only those that resolve to a real profile), then the remaining
 * keys alphabetically.
 */
export function orderProfileKeys(
  profiles: Record<string, unknown>,
  profileOrder: readonly string[] | undefined,
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const name of profileOrder ?? []) {
    if (profiles[name] != null && !seen.has(name)) {
      ordered.push(name);
      seen.add(name);
    }
  }
  const tail = Object.keys(profiles)
    .filter((n) => !seen.has(n))
    .sort();
  return [...ordered, ...tail];
}
