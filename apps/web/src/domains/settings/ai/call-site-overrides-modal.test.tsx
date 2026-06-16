/**
 * Tests for `CallSiteOverridesModal` feature-flag gating.
 *
 * The modal auto-enumerates every call-site catalog entry, so flag-gated
 * entries (`workflowLeaf`, `analyzeConversation`) must be filtered out of the
 * rendered list when their flag is off. We seed the catalog + config query
 * caches and drive the feature-flag store via `mock.module` (zustand v5 SSR —
 * never `setState`).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import * as daemonQueryGen from "@/generated/daemon/@tanstack/react-query.gen";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

let flags: Record<string, boolean> = {};

// Feature-flag store: `.use.<flag>()` accessors return booleans driven by the
// per-test `flags` map.
mock.module("@/stores/assistant-feature-flag-store", () => {
  const store = () => null;
  store.use = {
    analyzeConversation: () => flags.analyzeConversation ?? false,
    workflows: () => flags.workflows ?? false,
    queryComplexityRouting: () => false,
  };
  return { useAssistantFeatureFlagStore: store };
});

const CATALOG = {
  domains: [{ id: "agentLoop", displayName: "Agent Loop" }],
  callSites: [
    {
      id: "workflowLeaf",
      displayName: "Workflow Leaf",
      description: "Runs an ephemeral leaf agent.",
      domain: "agentLoop",
      defaultProfile: null,
    },
    {
      id: "analyzeConversation",
      displayName: "Analyze Conversation",
      description: "Analyzes a conversation.",
      domain: "agentLoop",
      defaultProfile: null,
    },
  ],
};

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  ...daemonQueryGen,
  configLlmCallsitesGetOptions: () => ({
    queryKey: [{ _id: "configLlmCallsitesGet" }],
    queryFn: () => Promise.resolve(CATALOG),
  }),
  configGetOptions: () => ({
    queryKey: [{ _id: "configGet" }],
    queryFn: () =>
      Promise.resolve({
        llm: {
          profiles: {},
          profileOrder: [],
          activeProfile: null,
          callSites: {},
        },
      }),
  }),
}));

const { CallSiteOverridesModal } = await import(
  "@/domains/settings/ai/call-site-overrides-modal"
);

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

describe("CallSiteOverridesModal — workflows flag gating", () => {
  test("hides Workflow Leaf when the workflows flag is off", async () => {
    flags = { workflows: false, analyzeConversation: false };
    render(
      <Wrapper>
        <CallSiteOverridesModal isOpen assistantId="asst-1" onClose={() => {}} />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(document.body.textContent).toContain("Action Overrides");
    });
    expect(renderedText()).not.toContain("Workflow Leaf");
  });

  test("shows Workflow Leaf when the workflows flag is on", async () => {
    flags = { workflows: true, analyzeConversation: false };
    render(
      <Wrapper>
        <CallSiteOverridesModal isOpen assistantId="asst-1" onClose={() => {}} />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(renderedText()).toContain("Workflow Leaf");
    });
  });

  test("analyzeConversation gating is independent of the workflows flag", async () => {
    flags = { workflows: true, analyzeConversation: false };
    render(
      <Wrapper>
        <CallSiteOverridesModal isOpen assistantId="asst-1" onClose={() => {}} />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(renderedText()).toContain("Workflow Leaf");
    });
    expect(renderedText()).not.toContain("Analyze Conversation");
  });
});
