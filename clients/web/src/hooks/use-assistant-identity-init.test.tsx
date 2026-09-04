/**
 * What the store learns from the identity fetch, including the ending the
 * store could not see before: a fetch that finished with nothing.
 *
 * `fetchAssistantIdentity` turns an unreachable runtime into a successful
 * `null`, so "still asking" and "asked and got nothing" both leave `version`
 * null. A consumer that has to decide something (a route that redirects when
 * the feature is off) needs those two apart, and this is the seam that tells
 * them apart.
 */

import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

import type { IdentityGetResponse } from "@/generated/daemon/types.gen";

let identityResult: IdentityGetResponse | null = null;

// Every mock spreads the real module: `mock.module` replaces it for the whole
// test process, so returning only the overridden export would erase the rest
// for any file that loads it later.
const identityModule = await import("@/assistant/identity");
mock.module("@/assistant/identity", () => ({
  ...identityModule,
  fetchAssistantIdentity: async () => identityResult,
}));

const prechatModule = await import("@/domains/onboarding/prechat");
mock.module("@/domains/onboarding/prechat", () => ({
  ...prechatModule,
  consumePendingAssistantName: () => null,
}));

const { useAssistantIdentityStore } =
  await import("@/stores/assistant-identity-store");
const { useAssistantIdentityInit } =
  await import("@/hooks/use-assistant-identity-init");

const ASSISTANT_ID = "asst-1";

const IDENTITY: IdentityGetResponse = {
  name: "Vel",
  role: "assistant",
  personality: "helpful",
  emoji: "*",
  home: "/home/vel",
  version: "0.11.9",
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

function renderInit() {
  return renderHook(
    () =>
      useAssistantIdentityInit({
        assistantId: ASSISTANT_ID,
        assistantStateKind: "active",
      }),
    { wrapper },
  );
}

beforeEach(() => {
  identityResult = null;
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("useAssistantIdentityInit", () => {
  test("records the dead end when the fetch answers with no identity", async () => {
    renderInit();

    await waitFor(() => {
      expect(useAssistantIdentityStore.getState().unavailableFor).toBe(
        ASSISTANT_ID,
      );
    });
    // The version stays absent rather than being invented: a later refetch may
    // still answer.
    expect(useAssistantIdentityStore.getState().version).toBeNull();
  });

  test("an identity that lands leaves no dead end recorded", async () => {
    identityResult = IDENTITY;
    renderInit();

    await waitFor(() => {
      expect(useAssistantIdentityStore.getState().version).toBe("0.11.9");
    });
    expect(useAssistantIdentityStore.getState().unavailableFor).toBeNull();
  });

  // A refetch that succeeds has to lift the bit, or every surface that acted
  // on it stays wrong for the rest of the session.
  test("an identity in hand lifts a dead end recorded earlier", () => {
    useAssistantIdentityStore.getState().markIdentityUnavailable(ASSISTANT_ID);
    useAssistantIdentityStore
      .getState()
      .setIdentity("Vel", "0.11.9", ASSISTANT_ID);

    expect(useAssistantIdentityStore.getState().unavailableFor).toBeNull();
  });
});
