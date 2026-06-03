/**
 * Tests for `ManageProfilesModal` — the SETTINGS surface that owns the
 * profile-create success toast.
 *
 * Per the provider-first-profile-quick-add plan (PR 5), the success toast for
 * a profile create fires from THIS surface's save resolve (create mode only),
 * NOT from the shared `ProfileEditorModal` — so the composer quick-add surface
 * can own its own toast without double-firing.
 *
 * We mock `use-daemon-config` (query + capturing mutation), the feature-flag
 * store, the connections query, and the design-library toast so we can drive a
 * provider-first create end to end and assert exactly one success toast fires.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import type { DaemonConfigPatch, ProfileEntry } from "@/domains/settings/ai/ai-types";
import type { ProviderConnection } from "@/domains/settings/ai/provider-connections-client";
import * as daemonQueryGen from "@/generated/daemon/@tanstack/react-query.gen";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

let toastSuccessCalls: string[] = [];
let mutatePatches: DaemonConfigPatch[] = [];
let profilesState: Record<string, ProfileEntry> = {};

mock.module("@vellum/design-library/components/toast", () => ({
  toast: {
    success: (message: string) => {
      toastSuccessCalls.push(message);
    },
    error: () => {},
  },
  Toaster: () => null,
  ToastContent: () => null,
}));

mock.module("@/domains/settings/ai/use-daemon-config", () => ({
  useDaemonConfigQuery: () => ({
    assistantId: "asst-1",
    config: undefined,
    profiles: profilesState,
    profileOrder: Object.keys(profilesState),
    orderedProfiles: [],
    activeProfile: null,
    callSites: {},
  }),
  useDaemonConfigMutation: () => ({
    mutateAsync: (patch: DaemonConfigPatch) => {
      mutatePatches.push(patch);
      return Promise.resolve({ data: undefined, resolvedId: "asst-1" });
    },
  }),
}));

// Feature-flag store: `.use.<flag>()` accessors return booleans.
mock.module("@/stores/assistant-feature-flag-store", () => {
  const store = () => null;
  store.use = {
    openAICompatibleEndpoints: () => false,
    chatgptSubscriptionAuth: () => false,
    queryComplexityRouting: () => false,
  };
  return { useAssistantFeatureFlagStore: store };
});

// Connections query — supply a single Anthropic connection so the provider-
// first picker offers "Anthropic" without needing the inline create path.
const connection: ProviderConnection = {
  name: "anthropic-personal",
  label: null,
  provider: "anthropic",
  auth: { type: "api_key", credential: "credential/anthropic/api_key" },
  models: null,
} as unknown as ProviderConnection;

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  ...daemonQueryGen,
  inferenceProviderconnectionsGetOptions: () => ({
    queryKey: [{ _id: "inferenceProviderconnectionsGet" }],
    queryFn: () => Promise.resolve({ connections: [connection] }),
  }),
  inferenceProviderconnectionsGetQueryKey: () => [
    { _id: "inferenceProviderconnectionsGet" },
  ],
}));

const { ManageProfilesModal } = await import(
  "@/domains/settings/ai/manage-profiles-modal"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Seed the connections cache so the provider-first picker has options on
  // first render (the modal reads from this query).
  client.setQueryData(
    [{ _id: "inferenceProviderconnectionsGet" }],
    { connections: [connection] },
  );
  return createElement(QueryClientProvider, { client }, children);
}

function getInputByPlaceholder(placeholder: string): HTMLInputElement {
  const input = Array.from(
    document.querySelectorAll<HTMLInputElement>("input"),
  ).find((el) => el.placeholder === placeholder);
  if (!input) {
    throw new Error(`expected an input with placeholder "${placeholder}"`);
  }
  return input;
}

function getButton(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent?.trim() === label);
  if (!match) throw new Error(`expected a "${label}" button`);
  return match;
}

function getSaveBtn(): HTMLButtonElement {
  const btn = document.querySelector<HTMLButtonElement>(
    '[data-testid="modal-save-btn"]',
  );
  if (!btn) throw new Error("expected a modal-save-btn");
  return btn;
}

function providerTrigger(): HTMLButtonElement {
  const trigger = document.querySelector<HTMLButtonElement>(
    'button[role="combobox"][aria-labelledby="profile-editor-provider-label"]',
  );
  if (!trigger) throw new Error("expected the Provider dropdown trigger");
  return trigger;
}

function pickOption(trigger: HTMLButtonElement, optionLabel: string): void {
  fireEvent.click(trigger);
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((o) => o.textContent?.trim() === optionLabel);
  if (!option) {
    throw new Error(`expected option "${optionLabel}"`);
  }
  fireEvent.click(option);
}

function selectModel(label: string): void {
  const provTrigger = providerTrigger();
  for (const trigger of Array.from(
    document.querySelectorAll<HTMLButtonElement>('button[role="combobox"]'),
  )) {
    if (trigger === provTrigger) continue;
    fireEvent.click(trigger);
    const option = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((o) => o.textContent?.trim() === label);
    if (option) {
      fireEvent.click(option);
      return;
    }
    fireEvent.click(trigger);
  }
  throw new Error(`expected a Model dropdown offering "${label}"`);
}

beforeEach(() => {
  toastSuccessCalls = [];
  mutatePatches = [];
  profilesState = {};
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ManageProfilesModal — profile-create success toast (Settings surface)", () => {
  test("fires exactly one success toast on a successful create", async () => {
    render(
      <Wrapper>
        <ManageProfilesModal isOpen assistantId="asst-1" onClose={() => {}} />
      </Wrapper>,
    );

    // Open the create editor.
    fireEvent.click(getButton("+ New Profile"));

    // Provider-first create: pick Anthropic, a model, then a name.
    pickOption(providerTrigger(), "Anthropic");
    selectModel("Claude Opus 4.8");

    fireEvent.change(getInputByPlaceholder("e.g. fast-cheap"), {
      target: { value: "my-profile" },
    });
    fireEvent.change(getInputByPlaceholder("e.g. Fast & Cheap"), {
      target: { value: "My Profile" },
    });

    await waitFor(() => {
      expect(getSaveBtn().disabled).toBe(false);
    });
    fireEvent.click(getSaveBtn());

    // The config mutation ran and the Settings surface fired one toast using
    // the entered label.
    await waitFor(() => {
      expect(mutatePatches.length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(toastSuccessCalls).toEqual(['Profile "My Profile" created']);
    });
  });
});
