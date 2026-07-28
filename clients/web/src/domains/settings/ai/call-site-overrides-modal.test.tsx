/**
 * Tests for `CallSiteOverridesModal` call-site enumeration and the
 * apply-one-profile-to-all-actions affordance.
 *
 * The modal auto-enumerates every call-site catalog entry except
 * `mainAgent` (the chat model is picked via the profile picker, not a
 * per-call-site override). We seed the catalog + config query caches
 * (zustand v5 SSR — never `setState`).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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
    {
      id: "heartbeatAgent",
      displayName: "Heartbeat Agent",
      description: "Runs background tasks on a schedule.",
      domain: "agentLoop",
      defaultProfile: null,
    },
  ],
};

const CONFIG = {
  llm: {
    profiles: {
      "my-byok": { label: "My BYOK", provider: "anthropic", model: "claude-fable-5" },
    },
    profileOrder: ["my-byok"],
    activeProfile: null,
    callSites: {},
  },
};

let configPatchBodies: unknown[] = [];

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  configLlmCallsitesGet: mock(async () => ({ data: CATALOG })),
  configGet: mock(async () => ({ data: CONFIG })),
  configPatch: async (options?: { body?: unknown }) => {
    configPatchBodies.push(options?.body);
    return { data: CONFIG };
  },
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
  client.setQueryData([{ _id: "configGet" }], CONFIG);
  return createElement(QueryClientProvider, { client }, children);
}

function renderedText(): string {
  return document.body.textContent ?? "";
}

function getButton(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent?.trim() === label);
  if (!match) {
    throw new Error(`expected a "${label}" button`);
  }
  return match;
}

function pickOption(trigger: HTMLElement, optionLabel: string): void {
  fireEvent.click(trigger);
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((o) => o.textContent?.trim() === optionLabel);
  if (!option) {
    throw new Error(`expected option "${optionLabel}"`);
  }
  fireEvent.click(option);
}

beforeEach(() => {
  configPatchBodies = [];
});

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

describe("CallSiteOverridesModal — apply to all", () => {
  test("applies the chosen profile to every call site and saves", async () => {
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
      expect(renderedText()).toContain("Use one profile for all actions");
    });

    // Before a profile is chosen the apply button is inert.
    expect(getButton("Apply to all").disabled).toBe(true);

    // The apply-all dropdown is the only combobox while no override is on.
    const trigger = document.querySelector<HTMLElement>(
      'button[role="combobox"]',
    );
    if (!trigger) throw new Error("expected the apply-all dropdown trigger");
    pickOption(trigger, "My BYOK");

    fireEvent.click(getButton("Apply to all"));
    fireEvent.click(getButton("Save"));

    await waitFor(() => {
      expect(configPatchBodies.length).toBe(1);
    });
    const body = configPatchBodies[0] as {
      llm: { callSites: Record<string, unknown> };
    };
    expect(body.llm.callSites).toEqual({
      workflowLeaf: { profile: "my-byok", provider: null, model: null },
      heartbeatAgent: { profile: "my-byok", provider: null, model: null },
    });
    expect("mainAgent" in body.llm.callSites).toBe(false);
  });
});
