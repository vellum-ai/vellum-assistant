/**
 * Tests for `useChatUsesVellumCredits`. The generated config/conversation
 * query options are `mock.module`-replaced so the hook reads seeded fixtures,
 * and the call-site default-profile hook is mocked to stand in for the
 * daemon's own `mainAgent` resolution. The QueryClient uses
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

let configFixture: unknown = null;
let conversationFixture: unknown = null;
let callSiteDefaultKey: string | null = null;

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  configGetOptions: () => ({
    queryKey: CONFIG_KEY,
    queryFn: () => configFixture ?? new Promise(() => {}),
  }),
  conversationsByIdGetOptions: () => ({
    queryKey: CONVERSATION_KEY,
    queryFn: () => conversationFixture ?? new Promise(() => {}),
  }),
}));

mock.module("@/hooks/use-call-site-default-profile", () => ({
  useCallSiteDefaultProfile: () => ({
    key: callSiteDefaultKey,
    label: callSiteDefaultKey,
  }),
}));

const { useChatUsesVellumCredits } =
  await import("./use-chat-uses-vellum-credits");

function config(profiles: Record<string, { usesVellumCredits?: boolean }>) {
  return { llm: { profiles } };
}

function setup(
  { conversationId }: { conversationId?: string } = {
    conversationId: "conv-1",
  },
) {
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
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return renderHook(
    () => useChatUsesVellumCredits("assistant-1", conversationId),
    { wrapper },
  );
}

describe("useChatUsesVellumCredits", () => {
  beforeEach(() => {
    configFixture = null;
    conversationFixture = null;
    callSiteDefaultKey = null;
  });

  test("false when the conversation's own profile is a BYO route", () => {
    configFixture = config({
      "chatgpt-sub": { usesVellumCredits: false },
      balanced: { usesVellumCredits: true },
    });
    conversationFixture = {
      conversation: { inferenceProfile: "chatgpt-sub" },
    };
    callSiteDefaultKey = "balanced";

    expect(setup().result.current).toBe(false);
  });

  test("true when the conversation's own profile is the managed route", () => {
    configFixture = config({ balanced: { usesVellumCredits: true } });
    conversationFixture = { conversation: { inferenceProfile: "balanced" } };

    expect(setup().result.current).toBe(true);
  });

  test("falls back to the daemon's mainAgent winner when nothing pins the chat", () => {
    configFixture = config({ "chatgpt-sub": { usesVellumCredits: false } });
    conversationFixture = { conversation: { inferenceProfile: null } };
    callSiteDefaultKey = "chatgpt-sub";

    expect(setup().result.current).toBe(false);
  });

  test("true when the winning profile carries no flag (older assistant)", () => {
    configFixture = config({ "chatgpt-sub": {} });
    conversationFixture = { conversation: { inferenceProfile: null } };
    callSiteDefaultKey = "chatgpt-sub";

    expect(setup().result.current).toBe(true);
  });

  test("true when no profile resolves at all", () => {
    configFixture = config({ "chatgpt-sub": { usesVellumCredits: false } });
    conversationFixture = { conversation: { inferenceProfile: null } };
    callSiteDefaultKey = null;

    expect(setup().result.current).toBe(true);
  });

  test("true while the config query is still loading", () => {
    conversationFixture = { conversation: { inferenceProfile: "chatgpt-sub" } };

    expect(setup().result.current).toBe(true);
  });
});
