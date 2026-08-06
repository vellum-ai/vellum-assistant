import type {
  ConfigGetResponse,
  DefaultProviderStatus,
  ProfileConnectionAvailability,
  ProviderConnection,
} from "@/generated/daemon/types.gen";

type LlmConfig = ConfigGetResponse["llm"];

export type AvailabilityStatus = ProfileConnectionAvailability["status"];
type DefaultProviderAvailabilityStatus =
  DefaultProviderStatus["availability"]["status"];

/**
 * Everything the classification reads. Availability inputs are the proof
 * side of the verdict: a BYOK classification is only trusted when the
 * connection it rests on is dispatchable (see
 * {@link defaultChatRouteBurnsManagedCredits}).
 */
export interface ChatRouteEvidence {
  llm: LlmConfig;
  connections: readonly ProviderConnection[];
  /**
   * Per-profile connection availability from `GET /inference/profiles`
   * (profile name -> status). Profiles absent from the map count as
   * unproven.
   */
  profileAvailability: ReadonlyMap<string, AvailabilityStatus>;
  /**
   * Availability of the `llm.defaultProvider` anchor route from
   * `GET /config/llm/default-provider`, when known.
   */
  defaultProviderAvailability?: DefaultProviderAvailabilityStatus;
  /** The active conversation's `inferenceProfile` pin, when the caller has one. */
  overrideProfile?: string | null;
}

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
 * Classify one dispatchable entry, holding a BYOK verdict to the proof
 * standard: dispatch soft-falls back to the (possibly platform-billed)
 * default transport when a credential fails at send time
 * (`selectProvider` in assistant/src/providers/call-site-routing.ts), so a
 * BYOK entry whose availability isn't a proven "ok" can still burn managed
 * credits and must classify as unknown. Managed verdicts need no proof: a
 * managed route stays managed regardless of credential health.
 */
function classifyEntry(
  entry: CreditRouteEntry,
  connections: readonly ProviderConnection[],
  availability: DefaultProviderAvailabilityStatus | undefined,
): boolean | null {
  const burns = entryBurnsManagedCredits(entry, connections);
  if (burns === false && availability !== "ok") {
    return null;
  }
  return burns;
}

/**
 * Whether the assistant's default chat route spends managed Vellum credits.
 *
 * Mirrors the daemon's `mainAgent` single-winner selection
 * (`selectWinningProfile` in assistant/src/config/llm-resolver.ts): the
 * conversation `inferenceProfile` pin, then `llm.activeProfile`, then the
 * `llm.callSites.mainAgent.profile` pin, then the `llm.defaultProvider`
 * anchor. A rung naming a missing, disabled, or incomplete (no own
 * provider+model) profile falls through, exactly as the daemon skips
 * unusable rungs. A mix rung follows the daemon's per-conversation seeded
 * pick: each usable arm classifies on its own route, and an unusable arm
 * stands for the seeds that fall through to the rest of the chain, so the
 * mix classifies as the tri-state any() of both.
 *
 * `null` (never a BYOK verdict) whenever the evidence can't settle the
 * question; callers fail open to showing the banners. That includes the
 * proof standard from {@link classifyEntry}: a BYOK verdict requires the
 * winning route's availability to be a proven "ok". The legacy top-level
 * `llm.default` body has no availability source, so it can classify managed
 * but never BYOK.
 *
 * Depends on the config GET wire view materializing effective profile bodies
 * (`overlayEffectiveProfilesForWire` daemon-side): code-owned default
 * profiles such as `balanced` have no stored body, and only the overlay puts
 * their resolved `provider`/`provider_connection` on the wire for this
 * derivation to read. If that overlay thinned out, every rung would go
 * `null` here and callers would fail open to showing the banners.
 */
export function defaultChatRouteBurnsManagedCredits(
  evidence: ChatRouteEvidence,
): boolean | null {
  const { llm, connections, profileAvailability } = evidence;

  const rungNames = [
    evidence.overrideProfile,
    llm?.activeProfile,
    llm?.callSites?.mainAgent?.profile,
  ].filter((name): name is string => !!name);

  const classifyNamedLeaf = (name: string): boolean | null => {
    const entry = llm?.profiles?.[name];
    if (!entry) {
      return null;
    }
    return classifyEntry(entry, connections, profileAvailability.get(name));
  };

  const classifyFromRung = (index: number): boolean | null => {
    if (index >= rungNames.length) {
      return classifyAnchor(evidence);
    }
    const name = rungNames[index];
    const entry = name ? llm?.profiles?.[name] : undefined;
    if (!name || !entry || entry.status === "disabled") {
      return classifyFromRung(index + 1);
    }
    if (entry.mix && entry.mix.length > 0) {
      return anyBurns(
        entry.mix.map((arm) => {
          const armEntry = llm?.profiles?.[arm.profile];
          const armUsable =
            !!armEntry &&
            armEntry.status !== "disabled" &&
            !armEntry.mix &&
            !!armEntry.provider &&
            !!armEntry.model;
          // A seed landing on an unusable arm skips this whole rung
          // daemon-side, so that arm stands for the rest of the chain.
          return armUsable
            ? classifyNamedLeaf(arm.profile)
            : classifyFromRung(index + 1);
        }),
      );
    }
    if (!entry.provider || !entry.model) {
      return classifyFromRung(index + 1);
    }
    return classifyNamedLeaf(name);
  };

  return classifyFromRung(0);
}

/**
 * The code-owned bottom of the chain: the shipped intent rungs all resolve
 * their billing route through `llm.defaultProvider` (plus the legacy
 * top-level `llm.default` body, which predates profiles).
 */
function classifyAnchor(evidence: ChatRouteEvidence): boolean | null {
  const { llm, connections } = evidence;
  const results: Array<boolean | null> = [];
  if (llm?.default) {
    // No availability source exists for the legacy body: managed can stand,
    // BYOK cannot be proven.
    results.push(classifyEntry(llm.default, connections, undefined));
  }
  if (llm?.defaultProvider) {
    results.push(
      classifyEntry(
        {
          provider: llm.defaultProvider.provider,
          provider_connection: llm.defaultProvider.connectionName,
        },
        connections,
        evidence.defaultProviderAvailability,
      ),
    );
  }
  if (results.length === 0) {
    return null;
  }
  return anyBurns(results);
}
