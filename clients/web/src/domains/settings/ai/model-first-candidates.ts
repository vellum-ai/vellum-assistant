/**
 * Resolver behind the model-first create flow: it turns the model catalog,
 * the assistant's provider connections, and what the assistant can reach into
 * the two lists that flow asks for.
 *
 * The first list is every model the assistant can use, deduplicated across
 * providers. `displayName` is the identity key, not `id`: the same model
 * carries a different id under each provider that hosts it ("Claude Opus 4.8"
 * is one id on Anthropic and another on OpenRouter) while the label a person
 * reads is the same, so a picker keyed by id would offer the same model three
 * times.
 *
 * The second list is, for one such model, the routes that can serve it, in
 * the order the user should consider them: connected routes first, then the
 * ones that need a key, a setup step, or a sign-in. Each candidate carries
 * back the per-provider model id, which is what the profile stores.
 *
 * Everything here is pure so the rules can be tested without a DOM. Copy is
 * caller-supplied for the same reason.
 */

import {
  getVisibleModelsForProvider,
  MODELS_BY_PROVIDER,
  type LlmCatalogModel,
} from "@/assistant/llm-model-catalog";
import {
  CHATGPT_CONNECTION_PROVIDER,
  OPENAI_COMPATIBLE_PROVIDER,
} from "@/domains/settings/ai/constants";
import {
  CATALOG_PROVIDERS,
  entryPickerValue,
  expandEndpointEntries,
  isProviderSelectableForAssistant,
  parseEntryPickerValue,
  providersServedByConnections,
  unconnectedProviders,
} from "@/domains/settings/ai/provider-availability";
import { connectionAuthTypeForProvider } from "@/domains/settings/ai/provider-editor-constants";
import type {
  ConnectionProvider,
  ProviderConnection,
} from "@/generated/daemon/types.gen";

/** What an unconnected candidate needs before it can serve a request. */
export type CandidateSetup = "api-key" | "set-up" | "sign-in";

export interface ProviderCandidate {
  /**
   * Identity of the row, shared with the provider picker's encoding: a bare
   * provider id means the kind's default entry, `<provider>::<name>` names one
   * connection among siblings.
   */
  readonly value: string;
  readonly provider: ConnectionProvider;
  /** The connection this row pins, or `""` for the kind's default entry. */
  readonly connectionName: string;
  /** Provider display name, or the connection's own label when it is named. */
  readonly label: string;
  /** Right-aligned annotation on the row ("Default", "Managed", "Custom"). */
  readonly meta?: string;
  /** The model id this route stores, which differs per provider. */
  readonly modelId: string;
  readonly connected: boolean;
  /** What an unconnected route still needs; `null` once it is connected. */
  readonly setup: CandidateSetup | null;
}

export interface ModelFirstOption {
  /** Cross-provider identity of the model, and the picker's option value. */
  readonly displayName: string;
  /**
   * The provider the model is filed under: the first in catalog order that
   * lists it. For a model several providers host this is the one that made
   * it available first, which for a first-party model is its vendor and for
   * an open-weights model is whichever host the catalog lists first.
   */
  readonly owner: ConnectionProvider;
  /** The model line this belongs to, or null when it has no older siblings. */
  readonly family: string | null;
  /** Every route that can serve it, connected ones first. */
  readonly candidates: readonly ProviderCandidate[];
  /** Distinct provider kinds among the candidates. */
  readonly providerCount: number;
  /** The one route's label, when a single provider kind serves the model. */
  readonly soleProviderLabel: string | null;
}

export interface ModelFirstInput {
  readonly connections: readonly ProviderConnection[];
  /** Whether feature-flagged catalog entries are visible. */
  readonly developerMode: boolean;
  readonly activeAssistantIsSelfHosted: boolean;
  /** Provider id to display name. */
  readonly labelFor: (provider: ConnectionProvider) => string;
  /** Meta on a kind's bare row once it expands into named entries. */
  readonly defaultEntryMetaLabel: string;
}

function setupForProvider(provider: ConnectionProvider): CandidateSetup {
  // The subscription is signed into rather than keyed, and it is not a
  // connectable kind, so it never reaches the auth-type helper below.
  if (provider === CHATGPT_CONNECTION_PROVIDER) {
    return "sign-in";
  }
  return connectionAuthTypeForProvider(provider) === "api_key"
    ? "api-key"
    : "set-up";
}

interface CandidateKinds {
  kinds: ConnectionProvider[];
  connected: Set<ConnectionProvider>;
}

/**
 * Every provider kind the create flow may offer, connected ones first, plus
 * the set of kinds that are connected.
 *
 * The ChatGPT subscription is a routing identity rather than a connectable
 * kind, so `unconnectedProviders` does not list it. It is added next to the
 * API-key route it shares its models with, which is where a user comparing
 * the two ways to reach a GPT model expects to find it.
 */
function candidateKinds(
  connections: readonly ProviderConnection[],
): CandidateKinds {
  const mutableConnections = [...connections];
  const served = providersServedByConnections(mutableConnections);
  const connected = new Set(served);
  const pending = unconnectedProviders(mutableConnections);
  if (!connected.has(CHATGPT_CONNECTION_PROVIDER)) {
    const openaiIndex = pending.indexOf("openai");
    if (openaiIndex >= 0) {
      pending.splice(openaiIndex + 1, 0, CHATGPT_CONNECTION_PROVIDER);
    } else {
      pending.push(CHATGPT_CONNECTION_PROVIDER);
    }
  }
  return { kinds: [...served, ...pending], connected };
}

/** One row of the shared provider-picker encoding. */
type PickerRow = ReturnType<typeof expandEndpointEntries>[number];

/**
 * Picker rows for one connected kind, keyed by row value. A kind with a
 * single connection yields one bare row; a kind with siblings yields its
 * default row plus one row per named connection.
 */
function entryRowsForKind(
  kind: ConnectionProvider,
  input: ModelFirstInput,
): PickerRow[] {
  return expandEndpointEntries(
    [kind],
    [...input.connections],
    input.labelFor,
    input.defaultEntryMetaLabel,
  );
}

function connectedCandidate(
  kind: ConnectionProvider,
  row: PickerRow,
  modelId: string,
): ProviderCandidate {
  return {
    value: row.value,
    provider: kind,
    connectionName: parseEntryPickerValue(row.value)?.connectionName ?? "",
    label: row.label,
    meta: row.meta,
    modelId,
    connected: true,
    setup: null,
  };
}

function unconnectedCandidate(
  kind: ConnectionProvider,
  modelId: string,
  input: ModelFirstInput,
): ProviderCandidate {
  return {
    value: kind,
    provider: kind,
    connectionName: "",
    label: input.labelFor(kind),
    modelId,
    connected: false,
    setup: setupForProvider(kind),
  };
}

function selectableKinds(input: ModelFirstInput): CandidateKinds {
  const { kinds, connected } = candidateKinds(input.connections);
  return {
    kinds: kinds.filter((kind) =>
      isProviderSelectableForAssistant(kind, input.activeAssistantIsSelfHosted),
    ),
    connected,
  };
}

interface CatalogEntry {
  readonly owner: ConnectionProvider;
  readonly family: string | null;
  /** Position within the owner's own catalog, which is authored newest first. */
  readonly rank: number;
}

/**
 * Where each model is filed, keyed by the display name that identifies it
 * across providers. Built from the raw catalog rather than
 * `getModelsForProvider`, because who lists a model first is a fact about the
 * catalog and does not move with a feature flag or a routing identity.
 */
const CATALOG_INDEX: ReadonlyMap<string, CatalogEntry> = (() => {
  const index = new Map<string, CatalogEntry>();
  for (const provider of CATALOG_PROVIDERS) {
    const models: readonly LlmCatalogModel[] = MODELS_BY_PROVIDER[provider];
    models.forEach((model, rank) => {
      if (index.has(model.displayName)) {
        return;
      }
      index.set(model.displayName, {
        owner: provider as ConnectionProvider,
        family: model.family ?? null,
        rank,
      });
    });
  }
  return index;
})();

/**
 * Every model the assistant can use, deduplicated by display name, in the
 * order a person should meet them: the models their connected routes already
 * serve, then the rest of the catalog.
 *
 * A model no reachable route serves is absent rather than disabled. This list
 * is the flow's first question, and an option that cannot lead anywhere is
 * not an answer to it.
 */
export function resolveModelFirstOptions(
  input: ModelFirstInput,
): ModelFirstOption[] {
  const { kinds, connected } = selectableKinds(input);
  const byDisplayName = new Map<string, ProviderCandidate[]>();
  const order: string[] = [];

  function add(displayName: string, candidate: ProviderCandidate): void {
    const existing = byDisplayName.get(displayName);
    if (existing) {
      existing.push(candidate);
      return;
    }
    byDisplayName.set(displayName, [candidate]);
    order.push(displayName);
  }

  for (const kind of kinds) {
    if (kind === OPENAI_COMPATIBLE_PROVIDER) {
      // A custom endpoint has no catalog: the models it serves are the ones
      // its own connection row lists, so each endpoint contributes only its
      // own models and is a candidate only for those.
      const rows = entryRowsForKind(kind, input);
      for (const connection of input.connections) {
        if (connection.provider !== OPENAI_COMPATIBLE_PROVIDER) {
          continue;
        }
        const row = rows.find(
          (candidateRow) =>
            candidateRow.value === entryPickerValue(kind, connection.name),
        );
        if (!row) {
          continue;
        }
        for (const model of connection.models ?? []) {
          add(
            model.displayName ?? model.id,
            connectedCandidate(kind, row, model.id),
          );
        }
      }
      continue;
    }

    const models = getVisibleModelsForProvider(kind, input.developerMode);
    if (models.length === 0) {
      continue;
    }
    if (!connected.has(kind)) {
      for (const model of models) {
        add(model.displayName, unconnectedCandidate(kind, model.id, input));
      }
      continue;
    }
    const rows = entryRowsForKind(kind, input);
    for (const model of models) {
      for (const row of rows) {
        add(model.displayName, connectedCandidate(kind, row, model.id));
      }
    }
  }

  return order.map((displayName) => {
    const candidates = byDisplayName.get(displayName) ?? [];
    const providerKinds = new Set(
      candidates.map((candidate) => candidate.provider),
    );
    const first = candidates[0];
    const soleProviderLabel =
      providerKinds.size === 1 && first !== undefined
        ? candidates.length === 1
          ? first.label
          : input.labelFor(first.provider)
        : null;
    // A model the static catalog does not know (a custom endpoint's own list)
    // is filed under the route that serves it, which is the only answer
    // available and the one the user picked it from.
    const entry = CATALOG_INDEX.get(displayName);
    return {
      displayName,
      owner: entry?.owner ?? first?.provider ?? OPENAI_COMPATIBLE_PROVIDER,
      family: entry?.family ?? null,
      candidates,
      providerCount: providerKinds.size,
      soleProviderLabel,
    };
  });
}

export interface ModelFirstGroup {
  /** The provider the section is named for. */
  readonly provider: ConnectionProvider;
  readonly label: string;
  /** The section's models, in the owner's own catalog order. */
  readonly options: readonly ModelFirstOption[];
}

/**
 * The model list as sections, which is how a list this long stays readable:
 * one heading per owning provider, the sections the user's own connections
 * reach first and the rest of the catalog after.
 *
 * Within a section the models keep the owner's catalog order, so the newest
 * of each line leads and {@link collapseSupersededVersions} can fold the rest
 * away.
 */
export function resolveModelFirstGroups(
  input: ModelFirstInput,
): ModelFirstGroup[] {
  const options = resolveModelFirstOptions(input);
  const byOwner = new Map<ConnectionProvider, ModelFirstOption[]>();
  for (const option of options) {
    const existing = byOwner.get(option.owner);
    if (existing) {
      existing.push(option);
      continue;
    }
    byOwner.set(option.owner, [option]);
  }

  const served = providersServedByConnections([...input.connections]);
  const ordered: ConnectionProvider[] = [];
  for (const provider of served) {
    if (byOwner.has(provider) && !ordered.includes(provider)) {
      ordered.push(provider);
    }
  }
  for (const provider of CATALOG_PROVIDERS) {
    const owner = provider as ConnectionProvider;
    if (byOwner.has(owner) && !ordered.includes(owner)) {
      ordered.push(owner);
    }
  }
  // A section whose owner the catalog does not list at all still gets drawn,
  // rather than dropping models the picker just offered.
  for (const owner of byOwner.keys()) {
    if (!ordered.includes(owner)) {
      ordered.push(owner);
    }
  }

  return ordered.map((provider) => ({
    provider,
    label: input.labelFor(provider),
    options: (byOwner.get(provider) ?? [])
      .slice()
      .sort(
        (a, b) =>
          (CATALOG_INDEX.get(a.displayName)?.rank ?? 0) -
          (CATALOG_INDEX.get(b.displayName)?.rank ?? 0),
      ),
  }));
}

/**
 * Split a section into the models it shows and the ones it folds away: the
 * first member of each line stays, its older siblings go behind the section's
 * own "show older versions" row. A model with no line always shows, having
 * nothing newer to stand behind.
 */
export function collapseSupersededVersions(
  options: readonly ModelFirstOption[],
): { shown: ModelFirstOption[]; hidden: ModelFirstOption[] } {
  const shown: ModelFirstOption[] = [];
  const hidden: ModelFirstOption[] = [];
  const led = new Set<string>();
  for (const option of options) {
    if (option.family === null) {
      shown.push(option);
      continue;
    }
    if (led.has(option.family)) {
      hidden.push(option);
      continue;
    }
    led.add(option.family);
    shown.push(option);
  }
  return { shown, hidden };
}

/**
 * Routes that accept a model id typed by hand, in the same order.
 *
 * The ChatGPT subscription is excluded: it validates every id against the
 * fixed Codex set, so a typed one could never dispatch through it.
 */
export function customModelProviderCandidates(
  input: ModelFirstInput,
  modelId: string,
): ProviderCandidate[] {
  const { kinds, connected } = selectableKinds(input);
  const candidates: ProviderCandidate[] = [];
  for (const kind of kinds) {
    if (kind === CHATGPT_CONNECTION_PROVIDER) {
      continue;
    }
    if (connected.has(kind)) {
      for (const row of entryRowsForKind(kind, input)) {
        candidates.push(connectedCandidate(kind, row, modelId));
      }
      continue;
    }
    candidates.push(unconnectedCandidate(kind, modelId, input));
  }
  return candidates;
}

/**
 * The candidate a model opens on: the first connected route, so the common
 * case needs no decision at all. With nothing connected the first route wins
 * instead, which is the one the flow then offers to connect inline.
 */
export function defaultProviderCandidate(
  candidates: readonly ProviderCandidate[],
): ProviderCandidate | null {
  return (
    candidates.find((candidate) => candidate.connected) ?? candidates[0] ?? null
  );
}
