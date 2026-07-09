/**
 * Tests for `LanguageModelCard` — the default-provider availability notice
 * (M7 PR 3).
 *
 * Mocks the generated SDK boundary; the availability GET flows through the
 * real generated react-query wrappers, and the server's message renders
 * verbatim (the daemon owns the explainable wording).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement } from "react";

import type { DefaultProviderStatus } from "@/generated/daemon/types.gen";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

let defaultProviderState: DefaultProviderStatus = {
  provider: null,
  resolvedConnectionName: null,
  availability: { status: "missing_default" },
};
let defaultProviderGetCalls = 0;

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-1",
}));

const actualSdk = await import("@/generated/daemon/sdk.gen");

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...actualSdk,
  configGet: async () => ({
    data: { llm: { profiles: {}, profileOrder: [], callSites: {} } },
  }),
  configLlmDefaultproviderGet: async () => {
    defaultProviderGetCalls += 1;
    return { data: defaultProviderState };
  },
  inferenceProviderconnectionsGet: async () => ({
    data: { connections: [] },
  }),
}));

const { LanguageModelCard } =
  await import("@/domains/settings/ai/language-model-card");
const { useAssistantIdentityStore } =
  await import("@/stores/assistant-identity-store");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setAvailability(
  status: DefaultProviderStatus["availability"]["status"],
  message?: string,
) {
  defaultProviderState = {
    provider: "anthropic",
    resolvedConnectionName: "anthropic-personal",
    availability: { status, ...(message ? { message } : {}) },
  };
}

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(LanguageModelCard),
    ),
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  defaultProviderState = {
    provider: "anthropic",
    resolvedConnectionName: "anthropic-personal",
    availability: { status: "ok" },
  };
  defaultProviderGetCalls = 0;
  // The notice is version-gated (assistants < 0.10.8 lack the route).
  useAssistantIdentityStore.getState().setIdentity("test-asst", "0.10.8");
});

afterEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("default-provider availability notice", () => {
  test("hidden when availability is ok", async () => {
    const result = renderCard();
    await waitFor(() => {
      expect(defaultProviderGetCalls).toBeGreaterThan(0);
    });
    expect(result.baseElement.querySelector('[role="alert"]')).toBeNull();
  });

  test("renders the server's message verbatim as an error for config problems", async () => {
    setAvailability(
      "missing_credential",
      'Connection "anthropic-personal" has no API key stored. Add one in Settings → Models & Services.',
    );

    const result = renderCard();
    await waitFor(() => {
      expect(result.baseElement.textContent).toContain(
        'Connection "anthropic-personal" has no API key stored',
      );
    });
    // Error tone renders role="alert".
    expect(
      result.baseElement.querySelector('[role="alert"]')?.textContent,
    ).toContain("has no API key stored");
  });

  test("renders unknown (credential store unreachable) as a soft warning", async () => {
    setAvailability(
      "unknown",
      "The credential store is unreachable, so the credential could not be verified. Try again shortly.",
    );

    const result = renderCard();
    await waitFor(() => {
      expect(result.baseElement.textContent).toContain("unreachable");
    });
    // Warning tone renders role="status", not role="alert".
    expect(result.baseElement.querySelector('[role="alert"]')).toBeNull();
    expect(
      result.baseElement.querySelector('[role="status"]')?.textContent,
    ).toContain("unreachable");
  });

  test("hidden with no query against assistants that predate the route", async () => {
    useAssistantIdentityStore.getState().setIdentity("test-asst", "0.10.7");
    setAvailability("missing_credential", "should never render");

    const result = renderCard();
    // Give the (gated-off) query a beat to definitely not fire.
    await waitFor(() => {
      expect(result.baseElement.textContent).toContain("Language Model");
    });
    expect(result.baseElement.textContent).not.toContain("should never render");
    expect(defaultProviderGetCalls).toBe(0);
  });

  test("clears after the Providers modal closes once the problem is fixed", async () => {
    setAvailability(
      "missing_credential",
      'Connection "anthropic-personal" has no API key stored.',
    );

    const result = renderCard();
    await waitFor(() => {
      expect(result.baseElement.textContent).toContain("has no API key stored");
    });

    // Open the Providers modal, "fix" the problem server-side, then close —
    // the close-triggered refetch must clear the notice without a reload.
    const providersButton = [
      ...result.baseElement.querySelectorAll("button"),
    ].find((b) => b.textContent === "Providers");
    fireEvent.click(providersButton as HTMLButtonElement);
    await waitFor(() => {
      expect(result.baseElement.textContent).toContain("Provider Connections");
    });

    setAvailability("ok");
    const doneButton = [...result.baseElement.querySelectorAll("button")].find(
      (b) => b.textContent === "Done",
    );
    fireEvent.click(doneButton as HTMLButtonElement);

    await waitFor(() => {
      expect(result.baseElement.textContent).not.toContain(
        "has no API key stored",
      );
    });
  });
});
