/**
 * Rules of the model-first create flow's resolver: which models the list
 * offers, which routes can serve one, and in what order.
 */

import { describe, expect, test } from "bun:test";

import { PROVIDER_DISPLAY_NAMES } from "@/assistant/llm-model-catalog";
import {
  customModelProviderCandidates,
  defaultProviderCandidate,
  resolveModelFirstOptions,
  type ModelFirstInput,
  type ProviderCandidate,
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

function optionFor(
  connections: ProviderConnection[],
  displayName: string,
  overrides: Partial<ModelFirstInput> = {},
) {
  const option = resolveModelFirstOptions(input(connections, overrides)).find(
    (candidate) => candidate.displayName === displayName,
  );
  if (!option) {
    throw new Error(`expected an option for "${displayName}"`);
  }
  return option;
}

function providersOf(candidates: readonly ProviderCandidate[]): string[] {
  return candidates.map((candidate) => candidate.provider);
}

const VELLUM_CONNECTION = connection("vellum", "vellum", {
  auth: { type: "platform" },
});

describe("resolveModelFirstOptions", () => {
  test("lists each model once across the providers that host it", () => {
    const options = resolveModelFirstOptions(input([]));
    const opus = options.filter(
      (option) => option.displayName === "Claude Opus 4.8",
    );
    expect(opus).toHaveLength(1);
    expect(new Set(providersOf(opus[0].candidates)).size).toBe(3);
  });

  test("keeps a model only one provider hosts on that one route", () => {
    const option = optionFor([], "Gemini 3.6 Flash");
    expect(providersOf(option.candidates)).toEqual(["gemini"]);
  });

  test("keeps the per-provider model id on each candidate", () => {
    const option = optionFor([], "Claude Opus 4.8");
    const anthropic = option.candidates.find(
      (candidate) => candidate.provider === "anthropic",
    );
    const openrouter = option.candidates.find(
      (candidate) => candidate.provider === "openrouter",
    );
    expect(anthropic?.modelId).toBe("claude-opus-4-8");
    expect(openrouter?.modelId).toBe("anthropic/claude-opus-4.8");
  });

  test("orders connected routes ahead of ones needing setup", () => {
    const option = optionFor(
      [connection("openrouter-key", "openrouter")],
      "Claude Opus 4.8",
    );
    expect(option.candidates[0].provider).toBe("openrouter");
    expect(option.candidates[0].connected).toBe(true);
    expect(
      option.candidates.slice(1).every((candidate) => !candidate.connected),
    ).toBe(true);
  });

  test("annotates what an unconnected route still needs", () => {
    const keyed = optionFor([], "Claude Opus 4.8").candidates.find(
      (candidate) => candidate.provider === "anthropic",
    );
    expect(keyed?.setup).toBe("api-key");

    const local = optionFor([], "Llama 3.2").candidates.find(
      (candidate) => candidate.provider === "ollama",
    );
    expect(local?.setup).toBe("set-up");
  });

  test("expands a kind with sibling connections into one row per key", () => {
    const option = optionFor(
      [
        connection("anthropic-work", "anthropic"),
        connection("anthropic-personal", "anthropic", { label: "Personal" }),
      ],
      "Claude Opus 4.8",
    );
    const anthropic = option.candidates.filter(
      (candidate) => candidate.provider === "anthropic",
    );
    expect(anthropic.map((candidate) => candidate.value)).toEqual([
      "anthropic",
      "anthropic::anthropic-work",
      "anthropic::anthropic-personal",
    ]);
    expect(anthropic[0].meta).toBe("Default");
    expect(anthropic[0].connectionName).toBe("");
    expect(anthropic[2].label).toBe("Personal");
    expect(anthropic[2].connectionName).toBe("anthropic-personal");
  });

  test("offers every key a kind holds as its own route", () => {
    const option = optionFor(
      [
        connection("gemini-work", "gemini"),
        connection("gemini-personal", "gemini"),
      ],
      "Gemini 3.6 Flash",
    );
    expect(option.candidates).toHaveLength(3);
    expect(new Set(providersOf(option.candidates)).size).toBe(1);
  });

  test("drops a route the active assistant cannot reach, and with it a model nothing else serves", () => {
    const platformHosted = resolveModelFirstOptions(
      input([], { activeAssistantIsSelfHosted: false }),
    );
    expect(
      platformHosted.map((option) => option.displayName),
    ).not.toContain("Llama 3.2");

    const selfHosted = optionFor([], "Llama 3.2");
    expect(providersOf(selfHosted.candidates)).toEqual(["ollama"]);
  });

  test("offers a custom endpoint only for the models its own row lists", () => {
    const options = resolveModelFirstOptions(
      input([
        connection("lm-studio", "openai-compatible", {
          label: "LM Studio",
          models: [{ id: "local-mixtral", displayName: "Local Mixtral" }],
        }),
      ]),
    );
    const custom = options.find(
      (option) => option.displayName === "Local Mixtral",
    );
    expect(custom?.candidates).toHaveLength(1);
    expect(custom?.candidates[0]).toMatchObject({
      provider: "openai-compatible",
      connectionName: "lm-studio",
      label: "LM Studio",
      modelId: "local-mixtral",
      connected: true,
    });

    const opus = options.find(
      (option) => option.displayName === "Claude Opus 4.8",
    );
    expect(providersOf(opus?.candidates ?? [])).not.toContain(
      "openai-compatible",
    );
  });

  test("holds a flagged catalog entry back until developer mode is on", () => {
    const hidden = resolveModelFirstOptions(
      input([VELLUM_CONNECTION]),
    ).map((option) => option.displayName);
    const shown = resolveModelFirstOptions(
      input([VELLUM_CONNECTION], { developerMode: true }),
    ).map((option) => option.displayName);
    expect(hidden).not.toContain("Qwen3 8B");
    expect(shown).toContain("Qwen3 8B");
  });

  test("surfaces the managed route as one entry rather than its upstreams", () => {
    const option = optionFor([VELLUM_CONNECTION], "Claude Opus 4.8");
    expect(option.candidates[0]).toMatchObject({
      provider: "vellum",
      value: "vellum",
      meta: "Managed",
      connected: true,
      modelId: "claude-opus-4-8",
    });
  });
});

describe("the ChatGPT subscription as a candidate", () => {
  const CODEX_MODEL = "GPT-5.6 Luna";
  const NON_CODEX_MODEL = "GPT-5.4 Nano";

  test("is offered for a Codex-eligible model and nothing else", () => {
    const codex = optionFor([], CODEX_MODEL);
    expect(providersOf(codex.candidates)).toContain("chatgpt");

    const other = optionFor([], NON_CODEX_MODEL);
    expect(providersOf(other.candidates)).not.toContain("chatgpt");
  });

  test("sits next to the API-key route it shares models with", () => {
    const providers = providersOf(optionFor([], CODEX_MODEL).candidates);
    expect(providers.indexOf("chatgpt")).toBe(providers.indexOf("openai") + 1);
  });

  test("is signed into rather than keyed while unconnected", () => {
    const chatgpt = optionFor([], CODEX_MODEL).candidates.find(
      (candidate) => candidate.provider === "chatgpt",
    );
    expect(chatgpt?.setup).toBe("sign-in");
    expect(chatgpt?.connected).toBe(false);
    expect(chatgpt?.label).toBe("ChatGPT Subscription");
  });

  test("leads and binds no connection once signed in", () => {
    const option = optionFor(
      [
        connection("chatgpt", "chatgpt", {
          auth: {
            type: "oauth_subscription",
            credential: "credential/chatgpt/oauth",
          },
        }),
      ],
      CODEX_MODEL,
    );
    // Identity rows never expand into per-connection entries: dispatch
    // resolves the canonical subscription row per request.
    expect(defaultProviderCandidate(option.candidates)).toMatchObject({
      provider: "chatgpt",
      value: "chatgpt",
      connectionName: "",
      connected: true,
      modelId: "gpt-5.6-luna",
    });
  });

  test("never accepts a model id typed by hand", () => {
    const candidates = customModelProviderCandidates(input([]), "some-model");
    expect(providersOf(candidates)).not.toContain("chatgpt");
  });
});

describe("defaultProviderCandidate", () => {
  test("prefers the first connected route", () => {
    const option = optionFor(
      [connection("together-key", "together")],
      "MiniMax M3",
    );
    expect(defaultProviderCandidate(option.candidates)).toMatchObject({
      provider: "together",
      connected: true,
      modelId: "MiniMaxAI/MiniMax-M3",
    });
  });

  test("falls back to the first route when nothing is connected", () => {
    const option = optionFor([], "Claude Opus 4.8");
    expect(defaultProviderCandidate(option.candidates)).toBe(
      option.candidates[0],
    );
  });

  test("is null with no candidates at all", () => {
    expect(defaultProviderCandidate([])).toBeNull();
  });
});

describe("customModelProviderCandidates", () => {
  test("stamps the typed id on every route", () => {
    const candidates = customModelProviderCandidates(input([]), "my/model:1");
    expect(candidates.length).toBeGreaterThan(0);
    expect(
      candidates.every((candidate) => candidate.modelId === "my/model:1"),
    ).toBe(true);
  });

  test("offers a route whose catalog is empty", () => {
    const candidates = customModelProviderCandidates(
      input([
        connection("lm-studio", "openai-compatible", { label: "LM Studio" }),
      ]),
      "local-model",
    );
    expect(
      candidates.some((candidate) => candidate.connectionName === "lm-studio"),
    ).toBe(true);
  });

  test("drops routes the active assistant cannot reach", () => {
    const candidates = customModelProviderCandidates(
      input([], { activeAssistantIsSelfHosted: false }),
      "local-model",
    );
    expect(providersOf(candidates)).not.toContain("ollama");
  });
});
