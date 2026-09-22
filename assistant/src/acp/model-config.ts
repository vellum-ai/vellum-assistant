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
 * `resolveAcpModel` is the precedence ladder a spawn or a resume walks before
 * it talks to the adapter: an explicit request beats the per-agent default from
 * `acp.agents.<id>.model`, and nothing named there leaves the adapter on its
 * own. Values are adapter-reported aliases (`opus`, `sonnet`), never Assistant
 * catalog ids, and are passed through unvalidated: only the adapter knows what
 * it accepts.
 *
 * Both helpers are synchronous and side-effect free.
 */

import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from "@agentclientprotocol/sdk";
import type { z } from "zod";

import type { AcpSessionModelUpdateEventSchema } from "../api/events/acp-session-model-update.js";

/**
 * A selectable model as reported by the adapter, flattened out of its group.
 * Derived from the event schema so the published wire shape and the shape the
 * daemon carries in memory cannot drift apart.
 */
export type AcpModelOption = z.infer<
  typeof AcpSessionModelUpdateEventSchema
>["availableModels"][number];

/** What an adapter's config-option set says about the session's model. */
export type AcpModelInfo = {
  model?: string;
  availableModels: AcpModelOption[];
  modelConfigId?: string;
};

type ResolveAcpModelInput = {
  requestedModel?: string;
  agentModel?: string;
};

type ModelSelectOption = Extract<SessionConfigOption, { type: "select" }>;

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
 * The adapter's model selector, if it advertises one. `category` is UX-only
 * per the ACP spec, so a `model` id counts too; non-select options never do.
 */
function findModelConfigOption(
  configOptions: SessionConfigOption[] | null | undefined,
): ModelSelectOption | undefined {
  return configOptions?.find(
    (option): option is ModelSelectOption =>
      option.type === "select" &&
      (option.id === "model" || option.category === "model"),
  );
}

/**
 * Extract current model, selectable models, and the config id to write back.
 * Returns `{ availableModels: [] }` when the adapter advertises no model
 * selector, which is how the whole feature degrades to invisible.
 */
export function deriveModelInfo(
  configOptions: SessionConfigOption[] | null | undefined,
): AcpModelInfo {
  const modelOption = findModelConfigOption(configOptions);

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
  const ladder = [input.requestedModel, input.agentModel];

  for (const candidate of ladder) {
    const trimmed = candidate?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}
