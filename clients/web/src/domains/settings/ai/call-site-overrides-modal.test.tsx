/**
 * Tests for `CallSiteOverridesModal` call-site enumeration.
 *
 * The modal auto-enumerates every call-site catalog entry except
 * `mainAgent` (the chat model is picked via the profile picker, not a
 * per-call-site override). We seed the catalog + config query caches
 * (zustand v5 SSR — never `setState`).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import * as daemonSdk from "@/generated/daemon/sdk.gen";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const CATALOG = {
  domains: [{ id: "agentLoop", displayName: "Agent Loop" }],
  callSites: [
    {
      id: "mainAgent",
      displayName: "Main Agent",
      description: "The primary chat agent.",
      domain: "agentLoop",
      defaultProfile: null,
    },
    {
      id: "workflowLeaf",
      displayName: "Workflow Leaf",
      description: "Runs an ephemeral leaf agent.",
      domain: "agentLoop",
      defaultProfile: null,
    },
  ],
};

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  configLlmCallsitesGet: mock(async () => ({ data: CATALOG })),
  configGet: mock(async () => ({
    data: {
      llm: {
        profiles: {},
        profileOrder: [],
        activeProfile: null,
        callSites: {},
      },
    },
  })),
}));

const { CallSiteOverridesModal } =
  await import("@/domains/settings/ai/call-site-overrides-modal");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  client.setQueryData([{ _id: "configLlmCallsitesGet" }], CATALOG);
  client.setQueryData([{ _id: "configGet" }], {
    llm: { profiles: {}, profileOrder: [], activeProfile: null, callSites: {} },
  });
  return createElement(QueryClientProvider, { client }, children);
}

function renderedText(): string {
  return document.body.textContent ?? "";
}

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CallSiteOverridesModal — call-site enumeration", () => {
  test("renders catalog call sites but excludes mainAgent", async () => {
    render(
      <Wrapper>
        <CallSiteOverridesModal
          isOpen
          assistantId="asst-1"
          onClose={() => {}}
        />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(renderedText()).toContain("Workflow Leaf");
    });
    expect(renderedText()).not.toContain("Main Agent");
  });
});
