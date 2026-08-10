import {
  getModelsForProvider,
  MODELS_BY_PROVIDER,
  VELLUM_SERVED_PROVIDERS,
} from "@/assistant/llm-model-catalog";
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
  /**
   * The connection the default-provider route conventionally resolves to
   * when `connectionName` is unset (`resolvedConnectionName` from the same
   * status response).
   */
  defaultProviderResolvedConnection?: string | null;
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

const MANAGED_ROUTABLE = new Set<string>(VELLUM_SERVED_PROVIDERS);

/** The provider whose catalog owns a model id, mirroring the daemon's lookup. */
function catalogProviderForModel(model: string): string | undefined {
  for (const [provider, models] of Object.entries(MODELS_BY_PROVIDER)) {
    if (models.some((m) => m.id === model)) {
      return provider;
    }
  }
  return undefined;
}

/**
 * The billing route after the daemon layers the workspace
 * `llm.callSites.mainAgent` tweak over the winning fragment
 * (`resolveOverrideOrDefault` in assistant/src/config/llm-resolver.ts): an
 * explicit tweak provider replaces the winner's while keeping its binding; a
 * tweak model the winner's provider does not serve stamps the model's
 * catalog owner and drops the binding (the provider-agnostic managed
 * connection survives); and a vellum winner re-gains the managed connection
 * under a concrete managed-routable provider. The shipped mainAgent
 * call-site default carries only a profile intent, so the workspace entry is
 * the only route-affecting tweak source.
 *
 * Returns the composed route plus whether composition altered it (callers
 * void the winner's availability proof for altered routes, since the proof
 * attests a binding the composed route no longer dispatches on), or `null`
 * when the client catalog cannot settle the serves-model question.
 */
function composedMainAgentRoute(
  entry: CreditRouteEntry,
  llm: LlmConfig,
): { route: CreditRouteEntry; altered: boolean } | null {
  const tweak = llm?.callSites?.mainAgent;
  const tweakProvider = tweak?.provider ?? undefined;
  const tweakModel = tweak?.model ?? undefined;
  let route = entry;
  let altered = false;
  if (tweakProvider) {
    if (tweakProvider !== entry.provider) {
      route = {
        provider: tweakProvider,
        provider_connection: entry.provider_connection,
      };
      altered = true;
    }
  } else if (tweakModel) {
    if (!entry.provider) {
      // The daemon implies from its code-default provider here, which the
      // client does not know.
      return null;
    }
    const winnerModels = getModelsForProvider(entry.provider);
    if (winnerModels.length === 0) {
      // Unknown or routing-identity provider: serves-model can't be settled.
      return null;
    }
    if (!winnerModels.some((m) => m.id === tweakModel)) {
      const implied = catalogProviderForModel(tweakModel);
      if (implied && implied !== entry.provider) {
        const managedConnectionSurvives =
          entry.provider_connection === "vellum" &&
          MANAGED_ROUTABLE.has(implied);
        route = {
          provider: implied,
          ...(managedConnectionSurvives
            ? { provider_connection: "vellum" }
            : {}),
        };
        altered = true;
      }
    }
  }
  if (
    entry.provider === "vellum" &&
    route.provider &&
    route.provider !== "vellum" &&
    !route.provider_connection &&
    MANAGED_ROUTABLE.has(route.provider)
  ) {
    route = { ...route, provider_connection: "vellum" };
    altered = true;
  }
  return { route, altered };
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
 * mix classifies as the tri-state any() of both. Every winner is classified
 * as dispatched, with the workspace mainAgent call-site tweak composed over
 * it (see {@link composedMainAgentRoute}).
 *
 * `null` (never a BYOK verdict) whenever the evidence can't settle the
 * question; callers fail open to showing the banners. That includes the
 * proof standard from {@link classifyEntry}: a BYOK verdict requires the
 * winning route's availability to be a proven "ok".
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
  const { llm, profileAvailability } = evidence;

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
    return classifyDispatched(entry, evidence, profileAvailability.get(name));
  };

  const classifyFromRung = (index: number): boolean | null => {
    if (index >= rungNames.length) {
      return classifyAnchor(evidence);
    }
    const name = rungNames[index];
    const entry = name ? llm?.profiles?.[name] : undefined;
    if (!name || !entry) {
      return classifyFromRung(index + 1);
    }
    if (entry.mix && entry.mix.length > 0) {
      if (entry.status === "disabled") {
        return classifyFromRung(index + 1);
      }
      return anyBurns(
        entry.mix.map((arm) => {
          const armEntry = llm?.profiles?.[arm.profile];
          const armUsable =
            !!armEntry &&
            armEntry.status !== "disabled" &&
            !armEntry.mix &&
            !!armEntry.provider &&
            !!armEntry.model;
          if (armUsable) {
            return classifyNamedLeaf(arm.profile);
          }
          // Arms expand through the same stale-stub exception as rungs
          // (`providerAwareEntry` daemon-side), so an unusable invariant
          // stub resolves to the default-provider route; any other
          // unusable arm skips this whole rung for its seeds and stands
          // for the rest of the chain.
          return armEntry?.invariant === true
            ? classifyStaleDefaultStub(evidence)
            : classifyFromRung(index + 1);
        }),
      );
    }
    if (entry.status === "disabled" || !entry.provider || !entry.model) {
      // An unusable managed-source stub of a code-owned default (the wire
      // marks those `invariant`) does NOT fall through: the daemon's
      // `providerAwareEntry` ignores the stale stub (defaults cannot be
      // disabled through any write path) and resolves the pure catalog body
      // through `llm.defaultProvider`, so this rung classifies as that
      // route instead.
      if (entry.invariant === true) {
        return classifyStaleDefaultStub(evidence);
      }
      return classifyFromRung(index + 1);
    }
    return classifyNamedLeaf(name);
  };

  return classifyFromRung(0);
}

/**
 * The billing route of the `llm.defaultProvider` anchor: the explicit
 * `connectionName` when set, else the conventionally resolved connection the
 * daemon stamps onto default bodies (`resolvedConnectionName` from the
 * default-provider status), so an unset name doesn't misread as unbound
 * dispatch. Null when no default provider is configured.
 */
function defaultProviderRouteEntry(
  evidence: ChatRouteEvidence,
): CreditRouteEntry | null {
  const defaultProvider = evidence.llm?.defaultProvider;
  if (!defaultProvider) {
    return null;
  }
  return {
    provider: defaultProvider.provider,
    provider_connection:
      defaultProvider.connectionName ??
      evidence.defaultProviderResolvedConnection ??
      undefined,
  };
}

/**
 * The route a stale (unusable) managed default stub actually resolves to:
 * the pure catalog body through `llm.defaultProvider`'s column, or the
 * catalog's own vellum column (managed) when no default provider is set.
 */
function classifyStaleDefaultStub(evidence: ChatRouteEvidence): boolean | null {
  const entry = defaultProviderRouteEntry(evidence);
  if (!entry) {
    return true;
  }
  return classifyDispatched(
    entry,
    evidence,
    evidence.defaultProviderAvailability,
  );
}

/**
 * Classify what the mainAgent call site actually dispatches: the winning
 * fragment with the workspace call-site tweak composed over it. The winner's
 * availability proof only carries when composition left the route unchanged;
 * an altered route dispatches on something the proof never attested, so its
 * BYOK verdicts degrade to unknown while managed verdicts stand.
 */
function classifyDispatched(
  entry: CreditRouteEntry,
  evidence: ChatRouteEvidence,
  availability: DefaultProviderAvailabilityStatus | undefined,
): boolean | null {
  const composed = composedMainAgentRoute(entry, evidence.llm);
  if (composed === null) {
    return null;
  }
  return classifyEntry(
    composed.route,
    evidence.connections,
    composed.altered ? undefined : availability,
  );
}

/**
 * The code-owned bottom of the chain: the shipped intent rungs all resolve
 * their billing route through `llm.defaultProvider`. The legacy top-level
 * `llm.default` body is deliberately NOT consulted: the daemon's `mainAgent`
 * resolver never reads it, so a stale value must not defeat a genuine BYOK
 * default-provider verdict.
 */
function classifyAnchor(evidence: ChatRouteEvidence): boolean | null {
  const entry = defaultProviderRouteEntry(evidence);
  if (!entry) {
    return null;
  }
  return classifyDispatched(
    entry,
    evidence,
    evidence.defaultProviderAvailability,
  );
}
