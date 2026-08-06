/**
 * Tests for `useChatUsesVellumCredits`. The generated config / conversation /
 * connections query options are `mock.module`-replaced so the hook reads
 * seeded fixtures, and the call-site default-profile hook is mocked to stand
 * in for the daemon's own `mainAgent` resolution. The QueryClient uses
 * `staleTime/gcTime: Infinity` + `retry: false` so a seeded cache resolves
 * synchronously and an unseeded query stays unresolved (its `queryFn` hangs),
 * modeling the loading state.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

const CONFIG_KEY = ["config"];
const CONVERSATION_KEY = ["conversation"];
const CONNECTIONS_KEY = ["connections"];

let configFixture: unknown = null;
let conversationFixture: unknown = null;
let connectionsFixture: unknown = null;
let callSiteDefaultKey: string | null = null;
let orgReady = true;
// Counts daemon fetches so the org-readiness gate can be asserted.
let fetches = 0;

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  configGetOptions: () => ({
    queryKey: CONFIG_KEY,
    queryFn: () => {
      fetches += 1;
      return configFixture ?? new Promise(() => {});
    },
  }),
  conversationsByIdGetOptions: () => ({
    queryKey: CONVERSATION_KEY,
    queryFn: () => {
      fetches += 1;
      return conversationFixture ?? new Promise(() => {});
    },
  }),
  inferenceProviderconnectionsGetOptions: () => ({
    queryKey: CONNECTIONS_KEY,
    queryFn: () => {
      fetches += 1;
      return connectionsFixture ?? new Promise(() => {});
    },
  }),
}));

mock.module("@/hooks/use-call-site-default-profile", () => ({
  useCallSiteDefaultProfile: () => ({
    key: callSiteDefaultKey,
    label: callSiteDefaultKey,
  }),
}));

mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => orgReady,
}));

const { useChatUsesVellumCredits } =
  await import("./use-chat-uses-vellum-credits");

const MANAGED_CONNECTION = { name: "vellum", provider: "vellum" };
const BYOK_CONNECTION = { name: "openai-personal", provider: "openai" };
const CHATGPT_CONNECTION = { name: "chatgpt-subscription", provider: "openai" };

function setup({
  conversationId = "conv-1",
}: { conversationId?: string } = {}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        gcTime: Infinity,
      },
    },
  });
  if (configFixture) {
    client.setQueryData(CONFIG_KEY, configFixture);
  }
  if (conversationFixture) {
    client.setQueryData(CONVERSATION_KEY, conversationFixture);
  }
  if (connectionsFixture) {
    client.setQueryData(CONNECTIONS_KEY, connectionsFixture);
  }
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return renderHook(
    () => useChatUsesVellumCredits("assistant-1", conversationId),
    { wrapper },
  );
}

/** Seed the three queries the hook reads. */
function seed(
  profiles: Record<string, Record<string, unknown>>,
  options: {
    conversationProfile?: string | null;
    connections?: { name: string; provider: string }[];
    mainAgentProfile?: string | null;
  } = {},
) {
  configFixture = { llm: { profiles } };
  conversationFixture = {
    conversation: { inferenceProfile: options.conversationProfile ?? null },
  };
  connectionsFixture = {
    connections: options.connections ?? [
      MANAGED_CONNECTION,
      BYOK_CONNECTION,
      CHATGPT_CONNECTION,
    ],
  };
  callSiteDefaultKey = options.mainAgentProfile ?? null;
}

describe("useChatUsesVellumCredits", () => {
  beforeEach(() => {
    configFixture = null;
    conversationFixture = null;
    connectionsFixture = null;
    callSiteDefaultKey = null;
    orgReady = true;
    fetches = 0;
  });

  test("false when the conversation runs on a ChatGPT-subscription profile", () => {
    seed(
      {
        "chatgpt-sub": {
          provider: "openai",
          model: "gpt-5.3-codex",
          provider_connection: "chatgpt-subscription",
        },
        balanced: { provider: "vellum", model: "gpt-5.6-luna" },
      },
      { conversationProfile: "chatgpt-sub", mainAgentProfile: "balanced" },
    );

    expect(setup().result.current).toBe(false);
  });

  test("true when the conversation runs on the managed routing identity", () => {
    seed(
      { balanced: { provider: "vellum", model: "gpt-5.6-luna" } },
      { conversationProfile: "balanced" },
    );

    expect(setup().result.current).toBe(true);
  });

  test("true for a legacy managed profile bound to the vellum connection", () => {
    // Written by an older daemon: the managed upstream as `provider`, bound
    // to the provider-agnostic managed connection. Still platform-billed.
    seed(
      {
        legacy: {
          provider: "fireworks",
          model: "accounts/fireworks/models/glm-5p2",
          provider_connection: "vellum",
        },
      },
      { conversationProfile: "legacy" },
    );

    expect(setup().result.current).toBe(true);
  });

  test("falls back to the daemon's mainAgent winner when nothing pins the chat", () => {
    seed(
      {
        "chatgpt-sub": {
          provider: "openai",
          model: "gpt-5.3-codex",
          provider_connection: "chatgpt-subscription",
        },
      },
      { mainAgentProfile: "chatgpt-sub" },
    );

    expect(setup().result.current).toBe(false);
  });

  test("true for a mix profile, whose arm the client cannot resolve", () => {
    seed(
      { blend: { mix: [{ profile: "chatgpt-sub", weight: 1 }] } },
      { conversationProfile: "blend" },
    );

    expect(setup().result.current).toBe(true);
  });

  test("true when no profile resolves at all", () => {
    seed({ "chatgpt-sub": { provider: "openai" } });

    expect(setup().result.current).toBe(true);
  });

  test("true while the config query is still loading", () => {
    conversationFixture = {
      conversation: { inferenceProfile: "chatgpt-sub" },
    };

    expect(setup().result.current).toBe(true);
  });

  test("no query fires header-less while the org store is unhydrated", () => {
    // Platform-mode requests need `Vellum-Organization-Id`; until the store
    // hydrates the hook reads nothing and stays on the safe default.
    orgReady = false;

    expect(setup().result.current).toBe(true);
    expect(fetches).toBe(0);
  });
});
