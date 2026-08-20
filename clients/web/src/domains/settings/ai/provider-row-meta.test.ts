import { describe, expect, test } from "bun:test";

import { getModelsForProvider } from "@/assistant/llm-model-catalog";
import { CODEX_SUBSCRIPTION_MODEL_IDS } from "@/domains/settings/ai/codex-subscription-models";
import {
  isDefaultConventionTarget,
  isDefaultProviderId,
  providerRowMeta,
} from "@/domains/settings/ai/provider-row-meta";
import type { ProviderConnection } from "@/generated/daemon/types.gen";

function connection(auth: ProviderConnection["auth"]): ProviderConnection {
  return {
    name: "openai-conn",
    provider: "openai",
    auth,
  } as ProviderConnection;
}

describe("default-provider eligibility", () => {
  test("the chatgpt identity row can be set as default", () => {
    expect(isDefaultProviderId("chatgpt")).toBe(true);
  });
});

describe("isDefaultConventionTarget", () => {
  const row = (name: string, provider: string) =>
    ({ name, provider }) as ProviderConnection;

  test("mirrors the daemon's convention resolution per provider", () => {
    expect(isDefaultConventionTarget(row("vellum", "vellum"))).toBe(true);
    expect(
      isDefaultConventionTarget(row("chatgpt-subscription", "chatgpt")),
    ).toBe(true);
    expect(
      isDefaultConventionTarget(row("anthropic-personal", "anthropic")),
    ).toBe(true);
  });

  test("suffix-named duplicates and noncanonical rows are not targets", () => {
    expect(
      isDefaultConventionTarget(row("anthropic-personal-2", "anthropic")),
    ).toBe(false);
    expect(isDefaultConventionTarget(row("my-vellum", "vellum"))).toBe(false);
    expect(isDefaultConventionTarget(row("chatgpt-personal", "chatgpt"))).toBe(
      false,
    );
  });
});

describe("providerRowMeta model counts", () => {
  test("an api-key openai row counts the full catalog", () => {
    const total = getModelsForProvider("openai").length;
    expect(
      providerRowMeta(
        connection({ type: "api_key", credential: "credential/openai" }),
      ),
    ).toBe(`${total} models  •  Own API key`);
  });

  test("a migrated subscription row (provider chatgpt) counts against the openai catalog", () => {
    const servable = getModelsForProvider("openai").filter((m) =>
      CODEX_SUBSCRIPTION_MODEL_IDS.has(m.id),
    ).length;
    expect(
      providerRowMeta({
        name: "chatgpt-subscription",
        provider: "chatgpt",
        auth: {
          type: "oauth_subscription",
          credential: "credential/chatgpt",
        },
      } as ProviderConnection),
    ).toBe(`${servable} models  •  ChatGPT subscription`);
  });

  test("a subscription openai row counts only Codex-servable models", () => {
    const servable = getModelsForProvider("openai").filter((m) =>
      CODEX_SUBSCRIPTION_MODEL_IDS.has(m.id),
    ).length;
    expect(servable).toBeGreaterThan(0);
    expect(servable).toBeLessThan(getModelsForProvider("openai").length);
    expect(
      providerRowMeta(
        connection({
          type: "oauth_subscription",
          credential: "credential/chatgpt",
        }),
      ),
    ).toBe(`${servable} models  •  ChatGPT subscription`);
  });
});

describe("providerRowMeta ollama endpoint", () => {
  test("ollama without a stored URL shows catalog models and keyless auth", () => {
    const total = getModelsForProvider("ollama").length;
    expect(
      providerRowMeta({
        name: "ollama",
        provider: "ollama",
        auth: { type: "none" },
      } as ProviderConnection),
    ).toBe(`${total} models  •  No API key needed`);
  });

  test("ollama with a stored URL prefixes the host", () => {
    const total = getModelsForProvider("ollama").length;
    expect(
      providerRowMeta({
        name: "ollama",
        provider: "ollama",
        auth: { type: "none" },
        baseUrl: "http://192.168.1.50:11434/v1",
      } as ProviderConnection),
    ).toBe(`192.168.1.50:11434  •  ${total} models  •  No API key needed`);
  });
});
