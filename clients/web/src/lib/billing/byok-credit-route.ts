import type {
  ConfigGetResponse,
  ProviderConnection,
} from "@/generated/daemon/types.gen";

type LlmConfig = ConfigGetResponse["llm"];

/**
 * The slice of a profile (or the legacy top-level default entry) that decides
 * which billing route its turns dispatch on.
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
 * Whether the assistant's default chat route — the global active profile, or
 * the legacy top-level default entries when no profile is active — spends
 * managed Vellum credits. `null` when the loaded config can't settle the
 * question.
 */
export function defaultChatRouteBurnsManagedCredits(
  llm: LlmConfig,
  connections: readonly ProviderConnection[],
): boolean | null {
  const active = llm?.activeProfile;
  if (active) {
    return profileBurnsManagedCredits(llm, active, connections);
  }
  const legacyEntries: CreditRouteEntry[] = [];
  if (llm?.default) {
    legacyEntries.push(llm.default);
  }
  if (llm?.defaultProvider) {
    legacyEntries.push({
      provider: llm.defaultProvider.provider,
      provider_connection: llm.defaultProvider.connectionName,
    });
  }
  if (legacyEntries.length === 0) {
    return null;
  }
  return anyBurns(
    legacyEntries.map((entry) => entryBurnsManagedCredits(entry, connections)),
  );
}
