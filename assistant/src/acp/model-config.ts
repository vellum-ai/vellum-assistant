/**
 * Pure helpers for ACP session model selection.
 *
 * ACP 0.25.0 has no `session/set_model`: a model is one `SessionConfigOption`
 * among the set an adapter reports from `session/new`, `session/load`,
 * `session/resume`, and `session/set_config_option`. `deriveModelInfo` turns
 * that raw set into the trio the daemon publishes and persists (current model,
 * selectable options, and the config id to write back through
 * `setSessionConfigOption`), flattening the grouped `options` variant so
 * callers never branch on it.
 *
 * The model option is identified by `type === "select"` and `id === "model"`
 * or `category === "model"` only. Option `name` is a human label an adapter
 * may localize or restyle at will, so it is never matched against.
 *
 * `resolveAcpModel` is the precedence ladder a spawn walks before it talks to
 * the adapter: an explicit request beats the conversation's remembered choice,
 * which beats the per-agent config default, which beats the global one. Values
 * are adapter-reported aliases (`opus`, `sonnet`), never Assistant catalog ids,
 * and are passed through unvalidated: only the adapter knows what it accepts.
 *
 * Both helpers are synchronous and side-effect free.
 */

import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from "@agentclientprotocol/sdk";

/** A selectable model as reported by the adapter, flattened out of its group. */
export type AcpModelOption = {
  value: string;
  label: string;
  description?: string;
  group?: string;
};

export type AcpModelInfo = {
  model?: string;
  availableModels: AcpModelOption[];
  modelConfigId?: string;
};

export type ResolveAcpModelInput = {
  requestedModel?: string;
  conversationPreference?: string;
  agentModel?: string;
  defaultModel?: string;
};

function isGroup(
  entry: SessionConfigSelectOption | SessionConfigSelectGroup,
): entry is SessionConfigSelectGroup {
  return "group" in entry;
}

function toModelOption(
  option: SessionConfigSelectOption,
  group?: string,
): AcpModelOption {
  return {
    value: option.value,
    label: option.name,
    ...(option.description ? { description: option.description } : {}),
    ...(group ? { group } : {}),
  };
}

/**
 * Extract current model, selectable models, and the config id to write back.
 * Returns `{ availableModels: [] }` when the adapter advertises no model
 * selector, which is how the whole feature degrades to invisible.
 */
export function deriveModelInfo(
  configOptions: SessionConfigOption[] | null | undefined,
): AcpModelInfo {
  const modelOption = configOptions?.find(
    (option): option is Extract<SessionConfigOption, { type: "select" }> =>
      option.type === "select" &&
      (option.id === "model" || option.category === "model"),
  );

  if (!modelOption) {
    return { availableModels: [] };
  }

  const availableModels: AcpModelOption[] = [];
  for (const entry of modelOption.options) {
    if (isGroup(entry)) {
      for (const option of entry.options) {
        availableModels.push(toModelOption(option, entry.name));
      }
      continue;
    }
    availableModels.push(toModelOption(entry));
  }

  return {
    ...(modelOption.currentValue ? { model: modelOption.currentValue } : {}),
    availableModels,
    modelConfigId: modelOption.id,
  };
}

/**
 * Pick the model a session should start on. Blank and whitespace-only values
 * count as unset so an empty config field never pins anything.
 */
export function resolveAcpModel(
  input: ResolveAcpModelInput,
): string | undefined {
  const ladder = [
    input.requestedModel,
    input.conversationPreference,
    input.agentModel,
    input.defaultModel,
  ];

  for (const candidate of ladder) {
    const trimmed = candidate?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}
