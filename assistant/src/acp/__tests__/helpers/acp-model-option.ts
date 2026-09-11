/**
 * Shared test fixture: the `SessionConfigOption` an adapter advertises for
 * model selection, shaped the way claude-agent-acp reports one (a `select`
 * with id and category `model`).
 */

import type { SessionConfigOption } from "@agentclientprotocol/sdk";

/** A model selector currently sitting on `currentValue`. */
export function modelOption(currentValue: string): SessionConfigOption {
  return {
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue,
    options: [
      { value: "sonnet", name: "Sonnet" },
      { value: "opus", name: "Opus", description: "Most capable" },
    ],
  };
}

/**
 * A model selector sitting on nothing. `deriveModelInfo` reads an empty
 * `currentValue` as "no model reported", which is the only shape that leaves a
 * resumed session with a selector to pin through.
 */
export function modelOptionWithoutCurrent(): SessionConfigOption {
  return modelOption("");
}

/**
 * A selector that is not the model one, so a set carrying only this reads as
 * an adapter that advertises no model selection.
 */
export function nonModelOption(): SessionConfigOption {
  return {
    type: "select",
    id: "mode",
    name: "Mode",
    currentValue: "default",
    options: [{ value: "default", name: "Default" }],
  };
}

/** `modelOption`'s options as `deriveModelInfo` flattens them. */
export const MODEL_OPTION_MODELS = [
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus", description: "Most capable" },
];
