/**
 * How the model-first list is shaped before anyone types: one section per
 * owning provider, three models offered in each, and the rest of the section
 * folded away behind them.
 */

import { describe, expect, test } from "bun:test";

import { PROVIDER_DISPLAY_NAMES } from "@/assistant/llm-model-catalog";
import {
  collapseSectionRows,
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

function groupFor(connections: ProviderConnection[], key: string) {
  const group = resolveModelFirstGroups(input(connections)).find(
    (entry) => entry.key === key,
  );
  if (!group) {
    throw new Error(`expected a "${key}" group`);
  }
  return group;
}

function namesOf(connections: ProviderConnection[], provider: string) {
  return groupFor(connections, provider).options.map(
    (option) => option.displayName,
  );
}

describe("resolveModelFirstGroups", () => {
  test("names a section for the organisation that made the models", () => {
    // A first-party lab lists its own work, so its own name stands.
    expect(groupFor([], "anthropic").label).toBe("Anthropic");
    expect(namesOf([], "anthropic")).toContain("Claude Opus 5");
    // Kimi is Moonshot's, Grok is xAI's, whichever gateway serves them.
    expect(groupFor([], "moonshot").label).toBe("Moonshot AI");
    expect(namesOf([], "moonshot")).toContain("Kimi K3");
    expect(groupFor([], "xai").label).toBe("xAI");
    expect(namesOf([], "xai")).toContain("Grok 4.6");
  });

  test("never names a section for a gateway", () => {
    const labels = groupLabels([]);
    for (const gateway of [
      "Fireworks",
      "OpenRouter",
      "Together AI",
      "Vercel AI Gateway",
      "Ollama",
      "Baseten",
    ]) {
      expect(labels, `${gateway} still names a section`).not.toContain(gateway);
    }
  });

  test("merges the providers that list one vendor's work", () => {
    // Fireworks lists the newest MiniMax, OpenRouter the older ones, and
    // MiniMax hosts its own: one section, each model once.
    const minimax = namesOf([], "minimax");
    expect(minimax).toContain("MiniMax M3");
    expect(minimax).toContain("MiniMax-01");
    expect(minimax.filter((name) => name === "MiniMax M3")).toHaveLength(1);
    expect(groupLabels([]).filter((label) => label === "MiniMax")).toHaveLength(
      1,
    );
    // A model two providers list still lands in one section, once.
    expect(namesOf([], "xai").filter((name) => name === "Grok 4.3")).toHaveLength(
      1,
    );
    // And a variant only a gateway lists joins its maker's section.
    expect(namesOf([], "openai")).toContain("GPT-5.6 Sol Pro");
  });

  test("leads with the sections the user's own connections reach", () => {
    expect(groupLabels([connection("gemini-key", "gemini")])[0]).toBe(
      "Google Gemini",
    );
    // Fireworks serves four vendors; the first of them in catalog order leads.
    expect(groupLabels([connection("fw-key", "fireworks")])[0]).toBe(
      "Moonshot AI",
    );
    // With nothing connected the catalog's own order stands.
    expect(groupLabels([])[0]).toBe("Anthropic");
  });

  test("sinks a section the user's connections cannot reach", () => {
    const labels = groupLabels([connection("openrouter-key", "openrouter")]);
    // OpenRouter serves Grok and Claude but no Gemini, so Gemini goes below
    // every section it does serve.
    expect(labels.indexOf("Google Gemini")).toBeGreaterThan(
      labels.indexOf("xAI"),
    );
    expect(labels.indexOf("Google Gemini")).toBeGreaterThan(
      labels.indexOf("Anthropic"),
    );
  });

  test("omits a section whose models the assistant cannot use", () => {
    // Ollama serves Llama 3.2, which only a self-hosted assistant reaches.
    expect(namesOf([], "meta")).toContain("Llama 3.2");
    const platformHosted = resolveModelFirstGroups(
      input([], { activeAssistantIsSelfHosted: false }),
    ).find((group) => group.key === "meta");
    expect(
      platformHosted?.options.map((option) => option.displayName),
    ).not.toContain("Llama 3.2");
  });

  test("keeps a section in its owner's catalog order", () => {
    expect(namesOf([], "anthropic").slice(0, 3)).toEqual([
      "Claude Fable 5.1",
      "Claude Fable 5",
      "Claude Opus 5",
    ]);
  });

  test("reads a merged vendor's section newest first", () => {
    // Z.ai's models all come from the one provider that lists them first, so
    // the section is that provider's own order: newest, then its fast
    // sibling, then the version before it.
    expect(namesOf([], "zhipu")).toEqual([
      "GLM 5.3",
      "GLM 5.3 Flash",
      "GLM 5.2",
    ]);
    // Moonshot's are split: Fireworks lists the newest two and OpenRouter the
    // one it does not, which lands under them rather than among them.
    expect(namesOf([], "moonshot")).toEqual([
      "Kimi K3",
      "Kimi K2.6",
      "Kimi K2.5",
    ]);
    // The same split under DeepSeek, where the two Fireworks serves are the
    // newest and the two only OpenRouter lists are older.
    expect(namesOf([], "deepseek")).toEqual([
      "DeepSeek V4 Pro",
      "DeepSeek V4 Flash",
      "DeepSeek R1",
      "DeepSeek V3",
    ]);
  });

  test("gives a model one row however many providers serve it", () => {
    // `displayName` is the cross-provider identity, so two providers spelling
    // one model differently would split it into two rows and hide one route
    // from the other. Z.ai's are served by two, under one name each.
    const zhipu = groupFor([], "zhipu").options;
    expect(zhipu).toHaveLength(3);
    const newest = zhipu.find((option) => option.displayName === "GLM 5.3");
    const providers = newest?.candidates.map((candidate) => candidate.provider);
    expect(providers).toContain("fireworks");
    expect(providers).toContain("openrouter");
  });

  test("carries the vendor on each option", () => {
    const byName = new Map(
      groupFor([], "xai").options.map((option) => [
        option.displayName,
        option.vendor,
      ]),
    );
    expect(byName.get("Grok 4.6")).toBe("xai");
    expect(
      groupFor([], "anthropic").options.every(
        (option) => option.vendor === null,
      ),
    ).toBe(true);
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
    expect(byName.get("Claude Fable 5.1")).toBe("claude-fable");
    expect(byName.get("Claude Fable 5")).toBe("claude-fable");
  });

  test("files a custom endpoint's own models under that endpoint", () => {
    const custom = resolveModelFirstGroups(
      input([
        connection("lm-studio", "openai-compatible", {
          label: "LM Studio",
          models: [{ id: "local-mixtral", displayName: "Local Mixtral" }],
        }),
      ]),
    ).find((group) => group.key === "openai-compatible");
    expect(custom?.options.map((option) => option.displayName)).toEqual([
      "Local Mixtral",
    ]);
  });
});

describe("collapseSectionRows", () => {
  function optionsFor(provider: string) {
    return groupFor([], provider).options;
  }

  test("offers three models and folds the rest of the section away", () => {
    const options = optionsFor("anthropic");
    const { shown, hidden } = collapseSectionRows(options);
    expect(shown.map((option) => option.displayName)).toEqual([
      "Claude Fable 5.1",
      "Claude Opus 5",
      "Claude Sonnet 5",
    ]);
    // The rest follows in catalog order, so revealing it reads as the section
    // carrying on rather than as a second list.
    expect(hidden.map((option) => option.displayName)).toEqual([
      "Claude Fable 5",
      "Claude Opus 4.8",
      "Claude Opus 4.7",
      "Claude Opus 4.6",
      "Claude Sonnet 4.6",
      "Claude Sonnet 4.5",
      "Claude Opus 4.5",
      "Claude Haiku 4.5",
    ]);
    expect(shown.length + hidden.length).toBe(options.length);
  });

  test("spends the three rows on three lines, not three versions of one", () => {
    // Every OpenAI line's newest member is a 5.6, so the section leads with
    // those rather than walking down through 5.5 and 5.4.
    const { shown } = collapseSectionRows(optionsFor("openai"));
    expect(shown.map((option) => option.displayName)).toEqual([
      "GPT-5.6 Sol",
      "GPT-5.6 Terra",
      "GPT-5.6 Luna",
    ]);
  });

  test("folds a version away without folding its fast sibling", () => {
    // GLM 5.3 and GLM 5.2 are one line, so only the newer stands; the Flash
    // is a line of its own and stands beside it.
    const { shown, hidden } = collapseSectionRows(optionsFor("zhipu"));
    expect(shown.map((option) => option.displayName)).toEqual([
      "GLM 5.3",
      "GLM 5.3 Flash",
    ]);
    expect(hidden.map((option) => option.displayName)).toEqual(["GLM 5.2"]);
  });

  test("folds nothing when a section holds three models or fewer", () => {
    const { shown, hidden } = collapseSectionRows(optionsFor("poolside"));
    expect(shown).toHaveLength(2);
    expect(hidden).toHaveLength(0);
  });
});
