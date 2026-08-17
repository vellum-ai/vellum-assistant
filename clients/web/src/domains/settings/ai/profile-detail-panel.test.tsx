/**
 * Tests for `ProfileDetailPanel` - the settings sidepanel host of the
 * profile editor.
 *
 * The panel owns the settings-surface save path and its create success
 * toast (the composer quick-add surface owns its own, so exactly one toast
 * fires per create). Managed profiles render read-only with Save As New;
 * a complete custom profile opens in edit with its stored values.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type {
  ProfileEntry,
  ProviderConnection,
} from "@/generated/daemon/types.gen";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

let toastSuccessCalls: string[] = [];
let configPatchBodies: unknown[] = [];
let profilesState: Record<string, ProfileEntry> = {};

function configPayload() {
  return {
    llm: {
      profiles: profilesState,
      profileOrder: Object.keys(profilesState),
      activeProfile: null,
      callSites: {},
    },
  };
}

mock.module("@vellumai/design-library/components/toast", () => ({
  toast: {
    success: (message: string) => {
      toastSuccessCalls.push(message);
    },
    error: () => {},
  },
  Toaster: () => null,
  ToastContent: () => null,
}));

const actualSdk = await import("@/generated/daemon/sdk.gen");

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...actualSdk,
  configGet: mock(async () => ({ data: configPayload() })),
  configPatch: async (options?: { body?: unknown }) => {
    configPatchBodies.push(options?.body);
    return { data: configPayload() };
  },
  inferenceProviderconnectionsGet: async () => ({
    data: { connections: [connection] },
  }),
}));

// Connections query - a single Anthropic connection so the provider-first
// picker offers "Anthropic" without needing the inline create path.
const connection: ProviderConnection = {
  name: "anthropic-personal",
  label: null,
  provider: "anthropic",
  auth: { type: "api_key", credential: "credential/anthropic/api_key" },
  models: null,
} as unknown as ProviderConnection;

const { configGetQueryKey, inferenceProviderconnectionsGetQueryKey } =
  await import("@/generated/daemon/@tanstack/react-query.gen");
const { ProfileDetailPanel } =
  await import("@/domains/settings/ai/profile-detail-panel");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  const queryKey = configGetQueryKey({ path: { assistant_id: "asst-1" } });
  client.setQueryData(queryKey, configPayload());
  // Seed the connections cache so the provider-first picker has options on
  // first render.
  client.setQueryData(
    inferenceProviderconnectionsGetQueryKey({
      path: { assistant_id: "asst-1" },
    }),
    { connections: [connection] },
  );
  return createElement(QueryClientProvider, { client }, children);
}

function renderPanel(
  profileName: string | null,
  onClose: () => void = () => {},
) {
  return render(
    <Wrapper>
      <ProfileDetailPanel
        assistantId="asst-1"
        profileName={profileName}
        onClose={onClose}
      />
    </Wrapper>,
  );
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
  if (!match) {
    throw new Error(`expected a "${label}" button`);
  }
  return match;
}

function providerTrigger(): HTMLButtonElement {
  const trigger = document.querySelector<HTMLButtonElement>(
    'button[role="combobox"][aria-labelledby="profile-editor-provider-label"]',
  );
  if (!trigger) {
    throw new Error("expected the Provider dropdown trigger");
  }
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
    if (trigger === provTrigger) {
      continue;
    }
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

beforeEach(async () => {
  toastSuccessCalls = [];
  configPatchBodies = [];
  profilesState = {};
  // Seed a hydrated version: the save path awaits
  // whenAssistantVersionKnown(), and an unhydrated store would stall each
  // save until that helper's timeout.
  const { useAssistantIdentityStore } =
    await import("@/stores/assistant-identity-store");
  useAssistantIdentityStore.getState().setIdentity("test-asst", "0.11.3");
});

afterEach(async () => {
  cleanup();
  const { useAssistantIdentityStore } =
    await import("@/stores/assistant-identity-store");
  useAssistantIdentityStore.getState().clearIdentity();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProfileDetailPanel - create flow", () => {
  test("fires exactly one success toast and closes on a successful create", async () => {
    let closed = 0;
    renderPanel(null, () => {
      closed += 1;
    });

    pickOption(providerTrigger(), "Anthropic");
    selectModel("Claude Opus 4.8");

    // Name leads the panel form; Key is flat in the panel layout (LUM-2881).
    fireEvent.change(getInputByPlaceholder("e.g. Fast & Cheap"), {
      target: { value: "My Profile" },
    });
    fireEvent.change(getInputByPlaceholder("e.g. fast-cheap"), {
      target: { value: "my-profile" },
    });

    await waitFor(() => {
      expect(getButton("Create Profile").disabled).toBe(false);
    });
    fireEvent.click(getButton("Create Profile"));

    await waitFor(() => {
      expect(configPatchBodies.length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(toastSuccessCalls).toEqual(['Profile "My Profile" created']);
    });
    expect(closed).toBe(1);
  });
});

describe("ProfileDetailPanel - managed profiles", () => {
  test("opens read-only with Save As New and no Delete", async () => {
    profilesState = {
      balanced: {
        label: "Balanced",
        source: "managed",
        invariant: true,
        provider: "anthropic",
        model: "claude-opus-4-8",
      },
    };
    renderPanel("balanced");

    await waitFor(() => {
      expect(getInputByPlaceholder("e.g. Fast & Cheap").disabled).toBe(true);
    });
    expect(document.body.textContent).toContain("Managed by Vellum");
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (b) => b.textContent?.trim() === "Save As New",
      ),
    ).toBe(true);
    // The header Delete is icon-only, so it is addressed by accessible name.
    expect(document.querySelector('button[aria-label="Delete"]')).toBeNull();
  });
});

describe("ProfileDetailPanel - edit flow", () => {
  test("a complete custom profile opens in edit with its stored values, not blanks", async () => {
    profilesState = {
      "my-custom": {
        label: "My Custom",
        source: "user",
        provider: "anthropic",
        model: "claude-opus-4-8",
        provider_connection: "anthropic-personal",
        maxTokens: 12345,
      },
    };
    renderPanel("my-custom");

    await waitFor(() => {
      expect(document.body.textContent).toContain("Max Output Tokens");
    });

    // The stored explicit budget renders as the field value - not as an
    // empty input reading "Default".
    const maxTokensInput = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="number"]'),
    ).find((el) => el.value === "12345");
    expect(maxTokensInput).toBeDefined();

    // Editable, with the panel footer's Save Changes and a header Delete.
    expect(getInputByPlaceholder("e.g. Fast & Cheap").disabled).toBe(false);
    expect(getButton("Save Changes")).toBeDefined();
    expect(
      document.querySelector('button[aria-label="Delete"]'),
    ).not.toBeNull();
  });
});
