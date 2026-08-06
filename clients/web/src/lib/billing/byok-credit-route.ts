import type {
  ConfigGetResponse,
  ProviderConnection,
} from "@/generated/daemon/types.gen";

type LlmConfig = ConfigGetResponse["llm"];

/**
 * The slice of a profile (or the default-provider anchor) that decides which
 * billing route its turns dispatch on.
 */
interface CreditRouteEntry {
  provider?: string;
  provider_connection?: string;
}

/**
 * Whether an entry's turns spend managed Vellum credits, mirroring the
 * daemon's dispatch rules (`effectiveConnectionAuth` in
 * assistant/src/providers/inference/auth.ts): the `vellum` provider IS the
 * managed route, a bound connection bills by its own auth type, and an
 * unbound entry falls back to a connection of its provider. `null` when the
 * question can't be settled from the loaded data (e.g. the bound connection
 * isn't in the list).
 */
function entryBurnsManagedCredits(
  entry: CreditRouteEntry,
  connections: readonly ProviderConnection[],
): boolean | null {
  if (entry.provider === "vellum") {
    return true;
  }
  if (entry.provider_connection) {
    // The canonical connection name is managed regardless of the stored row:
    // the daemon ignores a user-owned row claiming "vellum" and resolves the
    // route through platform auth anyway (`isManagedConnectionRoute` in
    // assistant/src/providers/connection-resolution.ts).
    if (entry.provider_connection === "vellum") {
      return true;
    }
    const bound = connections.find((c) => c.name === entry.provider_connection);
    if (!bound) {
      return null;
    }
    return bound.provider === "vellum" || bound.auth.type === "platform";
  }
  if (!entry.provider) {
    return null;
  }
  return connections.some(
    (c) => c.provider === entry.provider && c.auth.type === "platform",
  );
}

/** Tri-state any(): a burning member wins, else an unknown taints the set. */
function anyBurns(results: Array<boolean | null>): boolean | null {
  if (results.includes(true)) {
    return true;
  }
  return results.includes(null) ? null : false;
}

/**
 * Whether the named profile's turns spend managed Vellum credits. A mix
 * profile burns credits when any arm does; arm lookups guard against cycles
 * and unknown names (`null` = can't tell, callers treat it as "not proven
 * BYOK").
 */
export function profileBurnsManagedCredits(
  llm: LlmConfig,
  profileName: string,
  connections: readonly ProviderConnection[],
  seen: Set<string> = new Set(),
): boolean | null {
  if (seen.has(profileName)) {
    return false;
  }
  seen.add(profileName);
  const entry = llm?.profiles?.[profileName];
  if (!entry) {
    return null;
  }
  if (entry.mix && entry.mix.length > 0) {
    return anyBurns(
      entry.mix.map((arm) =>
        profileBurnsManagedCredits(llm, arm.profile, connections, seen),
      ),
    );
  }
  return entryBurnsManagedCredits(entry, connections);
}

/**
 * The name, or null, of a profile the daemon's single-winner selection would
 * accept for a rung: present, enabled, and carrying its own provider and
 * model (a mix stands on its arms instead). Mirrors the usability rule of
 * `selectWinningProfile` in assistant/src/config/llm-resolver.ts, so a rung
 * naming a disabled or incomplete profile falls through here exactly as the
 * daemon would skip it.
 */
function usableProfileName(
  llm: LlmConfig,
  name: string | null | undefined,
): string | null {
  if (!name) {
    return null;
  }
  const entry = llm?.profiles?.[name];
  if (!entry || entry.status === "disabled") {
    return null;
  }
  if (entry.mix && entry.mix.length > 0) {
    return name;
  }
  return entry.provider && entry.model ? name : null;
}

/**
 * Whether the assistant's default chat route spends managed Vellum credits.
 * Follows the daemon's `mainAgent` selection chain (`selectWinningProfile` in
 * assistant/src/config/llm-resolver.ts): `overrideProfile` (the active
 * conversation's `inferenceProfile` pin, when the caller has one), then
 * `llm.activeProfile`, then the `llm.callSites.mainAgent.profile` pin, then
 * the default-provider anchor that the shipped intent rungs resolve through
 * (plus the legacy top-level `llm.default` entry). `null` when the loaded
 * config can't settle the question.
 *
 * Depends on the config GET wire view materializing effective profile bodies
 * (`overlayEffectiveProfilesForWire` daemon-side): code-owned default
 * profiles such as `balanced` have no stored body, and only the overlay puts
 * their resolved `provider`/`provider_connection` on the wire for
 * {@link profileBurnsManagedCredits} to read. If that overlay thinned out,
 * every rung would go `null` here and callers would fail open to showing the
 * banners.
 */
export function defaultChatRouteBurnsManagedCredits(
  llm: LlmConfig,
  connections: readonly ProviderConnection[],
  overrideProfile?: string | null,
): boolean | null {
  const winner =
    usableProfileName(llm, overrideProfile) ??
    usableProfileName(llm, llm?.activeProfile) ??
    usableProfileName(llm, llm?.callSites?.mainAgent?.profile);
  if (winner) {
    return profileBurnsManagedCredits(llm, winner, connections);
  }
  const anchorEntries: CreditRouteEntry[] = [];
  if (llm?.default) {
    anchorEntries.push(llm.default);
  }
  if (llm?.defaultProvider) {
    anchorEntries.push({
      provider: llm.defaultProvider.provider,
      provider_connection: llm.defaultProvider.connectionName,
    });
  }
  if (anchorEntries.length === 0) {
    return null;
  }
  return anyBurns(
    anchorEntries.map((entry) => entryBurnsManagedCredits(entry, connections)),
  );
}
