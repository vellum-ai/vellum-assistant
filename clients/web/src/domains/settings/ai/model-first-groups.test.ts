/**
 * How the model-first list is shaped before anyone types: one section per
 * owning provider, and the older members of a model line folded away behind
 * the newest.
 */

import { describe, expect, test } from "bun:test";

import { PROVIDER_DISPLAY_NAMES } from "@/assistant/llm-model-catalog";
import {
  collapseSupersededVersions,
  resolveModelFirstGroups,
  type ModelFirstInput,
} from "@/domains/settings/ai/model-first-candidates";
import type { ProviderConnection } from "@/generated/daemon/types.gen";

function connection(
  name: string,
  provider: string,
  overrides: Record<string, unknown> = {},
): ProviderConnection {
  return {
    name,
    label: null,
    provider,
    auth: { type: "api_key", credential: `credential/${provider}/api_key` },
    models: null,
    ...overrides,
  } as unknown as ProviderConnection;
}

function input(
  connections: ProviderConnection[],
  overrides: Partial<ModelFirstInput> = {},
): ModelFirstInput {
  return {
    connections,
    developerMode: false,
    activeAssistantIsSelfHosted: true,
    labelFor: (provider) => PROVIDER_DISPLAY_NAMES[provider] ?? provider,
    defaultEntryMetaLabel: "Default",
    ...overrides,
  };
}

function groupLabels(connections: ProviderConnection[]): string[] {
  return resolveModelFirstGroups(input(connections)).map((group) => group.label);
}

function groupFor(connections: ProviderConnection[], provider: string) {
  const group = resolveModelFirstGroups(input(connections)).find(
    (entry) => entry.provider === provider,
  );
  if (!group) {
    throw new Error(`expected a "${provider}" group`);
  }
  return group;
}

function namesOf(connections: ProviderConnection[], provider: string) {
  return groupFor(connections, provider).options.map(
    (option) => option.displayName,
  );
}

describe("resolveModelFirstGroups", () => {
  test("files a model under the first provider the catalog lists it", () => {
    expect(namesOf([], "anthropic")).toContain("Claude Opus 5");
    // OpenRouter and Vercel host it too, but neither owns it.
    expect(namesOf([], "openrouter")).not.toContain("Claude Opus 5");
    // An open-weights model is filed under whichever host the catalog reaches
    // first, which is a host rather than the lab that trained it.
    expect(namesOf([], "fireworks")).toContain("Kimi K3");
  });

  test("leads with the sections the user's own connections reach", () => {
    expect(groupLabels([connection("openrouter-key", "openrouter")])[0]).toBe(
      "OpenRouter",
    );
    expect(groupLabels([connection("gemini-key", "gemini")])[0]).toBe(
      "Google Gemini",
    );
    // With nothing connected the catalog's own order stands.
    expect(groupLabels([])[0]).toBe("Anthropic");
  });

  test("omits a provider that owns no model the assistant can use", () => {
    // Together hosts MiniMax M3, but Fireworks lists it first and so owns it.
    expect(groupLabels([connection("together-key", "together")])).not.toContain(
      "Together AI",
    );
    expect(groupLabels([])).toContain("Ollama");
    expect(
      resolveModelFirstGroups(
        input([], { activeAssistantIsSelfHosted: false }),
      ).map((group) => group.label),
    ).not.toContain("Ollama");
  });

  test("keeps a section in its owner's catalog order", () => {
    expect(namesOf([], "anthropic").slice(0, 3)).toEqual([
      "Claude Fable 5",
      "Claude Opus 5",
      "Claude Opus 4.8",
    ]);
  });

  test("carries the family on each option", () => {
    const byName = new Map(
      groupFor([], "anthropic").options.map((option) => [
        option.displayName,
        option.family,
      ]),
    );
    expect(byName.get("Claude Opus 5")).toBe("claude-opus");
    expect(byName.get("Claude Opus 4.8")).toBe("claude-opus");
    expect(byName.get("Claude Fable 5")).toBeNull();
  });

  test("files a custom endpoint's own models under that endpoint", () => {
    const custom = resolveModelFirstGroups(
      input([
        connection("lm-studio", "openai-compatible", {
          label: "LM Studio",
          models: [{ id: "local-mixtral", displayName: "Local Mixtral" }],
        }),
      ]),
    ).find((group) => group.provider === "openai-compatible");
    expect(custom?.options.map((option) => option.displayName)).toEqual([
      "Local Mixtral",
    ]);
  });
});

describe("collapseSupersededVersions", () => {
  function optionsFor(provider: string) {
    return groupFor([], provider).options;
  }

  test("shows the newest of each line and folds the rest away", () => {
    const { shown, hidden } = collapseSupersededVersions(
      optionsFor("anthropic"),
    );
    expect(shown.map((option) => option.displayName)).toEqual([
      "Claude Fable 5",
      "Claude Opus 5",
      "Claude Sonnet 5",
      "Claude Haiku 4.5",
    ]);
    expect(hidden.map((option) => option.displayName)).toEqual([
      "Claude Opus 4.8",
      "Claude Opus 4.7",
      "Claude Opus 4.6",
      "Claude Sonnet 4.6",
      "Claude Sonnet 4.5",
      "Claude Opus 4.5",
    ]);
  });

  test("always shows a model with no older siblings", () => {
    const { shown } = collapseSupersededVersions(optionsFor("gemini"));
    expect(shown.map((option) => option.displayName)).toEqual([
      "Gemini 3.6 Flash",
      "Gemini 3.5 Flash-Lite",
      "Gemini 3.1 Pro Preview",
    ]);
  });

  test("folds nothing when a section holds one member per line", () => {
    const { shown, hidden } = collapseSupersededVersions(
      optionsFor("poolside"),
    );
    expect(shown).toHaveLength(2);
    expect(hidden).toHaveLength(0);
  });
});
