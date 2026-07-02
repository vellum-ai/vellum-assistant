/**
 * Tests for `ManageProfilesModal` — the SETTINGS surface that owns the
 * profile-create success toast.
 *
 * Per the provider-first-profile-quick-add plan (PR 5), the success toast for
 * a profile create fires from THIS surface's save resolve (create mode only),
 * NOT from the shared `ProfileEditorModal` — so the composer quick-add surface
 * can own its own toast without double-firing.
 *
 * We mock the generated SDK functions, the feature-flag store, the connections
 * query, and the design-library toast so we can drive a provider-first create
 * end to end and assert exactly one success toast fires.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type {
  ProfileEntry,
  ProviderConnection,
} from "@/generated/daemon/types.gen";
import * as daemonQueryGen from "@/generated/daemon/@tanstack/react-query.gen";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

let toastSuccessCalls: string[] = [];
let configPatchBodies: unknown[] = [];
let profilesState: Record<string, ProfileEntry> = {};

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

mock.module("@/generated/daemon/sdk.gen", () => ({
  configGet: mock(async () => ({
    data: {
      llm: {
        profiles: profilesState,
        profileOrder: Object.keys(profilesState),
        activeProfile: null,
        callSites: {},
      },
    },
  })),
  configPatch: async (options?: { body?: unknown }) => {
    configPatchBodies.push(options?.body);
    return {
      data: {
        llm: {
          profiles: profilesState,
          profileOrder: Object.keys(profilesState),
          activeProfile: null,
          callSites: {},
        },
      },
    };
  },
}));

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

const { configGetQueryKey } =
  await import("@/generated/daemon/@tanstack/react-query.gen");
const { ManageProfilesModal } =
  await import("@/domains/settings/ai/manage-profiles-modal");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  // Seed the connections cache so the provider-first picker has options on
  // first render (the modal reads from this query).
  client.setQueryData([{ _id: "inferenceProviderconnectionsGet" }], {
    connections: [connection],
  });
  // Seed the config cache
  const queryKey = configGetQueryKey({ path: { assistant_id: "asst-1" } });
  client.setQueryData(queryKey, {
    llm: {
      profiles: profilesState,
      profileOrder: Object.keys(profilesState),
      activeProfile: null,
      callSites: {},
    },
  });
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
  configPatchBodies = [];
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
      expect(configPatchBodies.length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(toastSuccessCalls).toEqual(['Profile "My Profile" created']);
    });
  });
});

// ---------------------------------------------------------------------------
// Invariant (default) profiles — server-stamped `invariant: true`
// ---------------------------------------------------------------------------

describe("ManageProfilesModal — invariant default profiles in the list", () => {
  // The list-item status toggle carries an "Enable <label>"/"Disable <label>"
  // aria-label — the accessible handle these tests query by.
  function findStatusToggle(action: "Enable" | "Disable", label: string) {
    return document.querySelector<HTMLButtonElement>(
      `[role="switch"][aria-label="${action} ${label}"]`,
    );
  }

  function seedInvariantProfiles() {
    profilesState = {
      "default-a": {
        label: "Default A",
        source: "managed",
        invariant: true,
        provider: "anthropic",
        model: "claude-opus-4-8",
      },
      // Invariant but NOT managed — the daemon freezes invariant names
      // regardless of `source`, so the UI must lock this one exactly like a
      // managed default.
      "default-user": {
        label: "Default User",
        source: "user",
        invariant: true,
        provider: "anthropic",
        model: "claude-opus-4-8",
      },
      "default-b": {
        label: "Default B",
        source: "managed",
        invariant: true,
        status: "disabled",
        provider: "anthropic",
        model: "claude-opus-4-8",
      },
      "custom-managed": {
        label: "Custom Managed",
        source: "managed",
        provider: "anthropic",
        model: "claude-opus-4-8",
      },
    };
  }

  test("an active invariant profile has no status toggle; a disabled one and non-invariant profiles keep theirs", () => {
    seedInvariantProfiles();
    render(
      <Wrapper>
        <ManageProfilesModal isOpen assistantId="asst-1" onClose={() => {}} />
      </Wrapper>,
    );

    // Active invariant profile: no disable affordance at all.
    expect(findStatusToggle("Disable", "Default A")).toBeNull();
    expect(findStatusToggle("Enable", "Default A")).toBeNull();

    // Disabled invariant profile: the enable affordance remains.
    expect(findStatusToggle("Enable", "Default B")).not.toBeNull();

    // Managed profile without the flag: behaves as before.
    expect(findStatusToggle("Disable", "Custom Managed")).not.toBeNull();
  });

  test("re-enabling a disabled invariant profile PATCHes status:'active' and nothing else", async () => {
    seedInvariantProfiles();
    render(
      <Wrapper>
        <ManageProfilesModal isOpen assistantId="asst-1" onClose={() => {}} />
      </Wrapper>,
    );

    fireEvent.click(findStatusToggle("Enable", "Default B")!);

    await waitFor(() => {
      expect(configPatchBodies.length).toBeGreaterThan(0);
    });
    expect(configPatchBodies).toEqual([
      { llm: { profiles: { "default-b": { status: "active" } } } },
    ]);
  });

  test("an invariant profile with source 'user' has a disabled delete button and a View action", () => {
    seedInvariantProfiles();
    render(
      <Wrapper>
        <ManageProfilesModal isOpen assistantId="asst-1" onClose={() => {}} />
      </Wrapper>,
    );

    // Delete is locked exactly like a managed profile — the daemon rejects
    // deleting invariant names regardless of source.
    const deleteBtn = document.querySelector<HTMLButtonElement>(
      '[aria-label="Delete Default User"]',
    );
    expect(deleteBtn).not.toBeNull();
    expect(deleteBtn!.disabled).toBe(true);

    // The row action reads "View", not "Edit" — the editor opens read-only.
    const row = deleteBtn!.closest("div.relative")!;
    const actionBtn = Array.from(
      row.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent?.trim() === "View" || b.textContent?.trim() === "Edit");
    expect(actionBtn?.textContent?.trim()).toBe("View");
  });

  test("opening an invariant source-'user' profile lands in view mode with locked controls", async () => {
    seedInvariantProfiles();
    render(
      <Wrapper>
        <ManageProfilesModal isOpen assistantId="asst-1" onClose={() => {}} />
      </Wrapper>,
    );

    const deleteBtn = document.querySelector<HTMLButtonElement>(
      '[aria-label="Delete Default User"]',
    )!;
    const row = deleteBtn.closest("div.relative")!;
    const viewBtn = Array.from(
      row.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent?.trim() === "View")!;
    fireEvent.click(viewBtn);

    // The editor opened in view mode: the read-only footer offers Save As
    // New, and the invariant lock disables the Display Name field.
    await waitFor(() => {
      expect(getButton("Save As New")).not.toBeNull();
    });
    expect(getInputByPlaceholder("e.g. Fast & Cheap").disabled).toBe(true);
    // Save opens disarmed — nothing view mode permits editing has changed.
    expect(getSaveBtn().disabled).toBe(true);
  });
});
