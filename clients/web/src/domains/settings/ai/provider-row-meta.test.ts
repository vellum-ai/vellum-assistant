import { describe, expect, test } from "bun:test";

import { getModelsForProvider } from "@/assistant/llm-model-catalog";
import { CODEX_SUBSCRIPTION_MODEL_IDS } from "@/domains/settings/ai/codex-subscription-models";
import {
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
