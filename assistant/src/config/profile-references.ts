/**
 * Live references to a named inference profile inside the raw `llm` config
 * block.
 *
 * Shared by the two write paths that must not strand a reference: the profile
 * DELETE route, and the disable guard at `commitConfigWrite`. It lives here
 * rather than beside either caller because `inference-profiles-routes.ts`
 * already imports the managed-profile guards from
 * `conversation-query-routes.ts`, so a helper either of them imports from the
 * other would close an import cycle.
 *
 * Operates on the RAW config shape (plain objects, unparsed) because both
 * callers run before the write is parsed.
 */

function asPlainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Enumerate every live reference to profile `name` in the raw `llm` config
 * block: `activeProfile`, `advisorProfile`, each `callSites.<id>.profile`, and
 * every mix arm (`profiles.<mix>.mix[].profile`).
 *
 * Deleting a profile while any of these point at it would leave a dangling
 * reference that `LLMSchema`'s superRefine rejects on the next load, silently
 * resetting the user's chat model or call-site pins. Disabling one is the same
 * hazard wearing a different hat: the reference still parses, but the resolver
 * skips the rung and the call site silently runs on a different model than the
 * one the settings UI shows pinned. Both write paths reject instead, and hand
 * the reference list back so the client can offer to repoint them.
 */
export function collectProfileReferences(
  llm: Record<string, unknown> | null,
  name: string,
): string[] {
  if (!llm) {
    return [];
  }
  const refs: string[] = [];
  if (llm.activeProfile === name) {
    refs.push("llm.activeProfile");
  }
  if (llm.advisorProfile === name) {
    refs.push("llm.advisorProfile");
  }
  const callSites = asPlainObject(llm.callSites);
  if (callSites) {
    for (const [siteId, siteConfig] of Object.entries(callSites)) {
      if (asPlainObject(siteConfig)?.profile === name) {
        refs.push(`llm.callSites.${siteId}`);
      }
    }
  }
  const profiles = asPlainObject(llm.profiles);
  if (profiles) {
    for (const [profileName, profileEntry] of Object.entries(profiles)) {
      const mix = asPlainObject(profileEntry)?.mix;
      if (
        Array.isArray(mix) &&
        mix.some((arm) => asPlainObject(arm)?.profile === name)
      ) {
        refs.push(`llm.profiles.${profileName}.mix`);
      }
    }
  }
  return refs;
}
