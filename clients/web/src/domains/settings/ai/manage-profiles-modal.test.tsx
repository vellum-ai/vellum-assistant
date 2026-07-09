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
  if (!match) {
    throw new Error(`expected a "${label}" button`);
  }
  return match;
}

function getSaveBtn(): HTMLButtonElement {
  const btn = document.querySelector<HTMLButtonElement>(
    '[data-testid="modal-save-btn"]',
  );
  if (!btn) {
    throw new Error("expected a modal-save-btn");
  }
  return btn;
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

    // Provider-first create: pick Anthropic and a model, then customize the
    // derived identity fields under Advanced.
    pickOption(providerTrigger(), "Anthropic");
    selectModel("Claude Opus 4.8");
    fireEvent.click(getButton("Advanced"));

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
// Invariant (managed) profiles — server-stamped `invariant: true`
// ---------------------------------------------------------------------------

describe("ManageProfilesModal — invariant managed profiles in the list", () => {
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
      // A user-owned profile sharing a managed name. The daemon stamps
      // `invariant` only on managed-source entries, so this one carries no
      // flag and must render as a normal, fully editable custom profile.
      "os-beta": {
        label: "My OS Beta",
        source: "user",
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

    // User-owned profile without the flag: two-way toggle as usual.
    expect(findStatusToggle("Disable", "My OS Beta")).not.toBeNull();
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

  test("a user-owned profile sharing a managed name gets an Edit action and an enabled delete button", () => {
    seedInvariantProfiles();
    render(
      <Wrapper>
        <ManageProfilesModal isOpen assistantId="asst-1" onClose={() => {}} />
      </Wrapper>,
    );

    // Delete stays available — the daemon gates invariance on managed
    // ownership, so a user-owned entry named like a managed profile is
    // fully deletable.
    const deleteBtn = document.querySelector<HTMLButtonElement>(
      '[aria-label="Delete My OS Beta"]',
    );
    expect(deleteBtn).not.toBeNull();
    expect(deleteBtn!.disabled).toBe(false);

    // The row action reads "Edit", not "View" — the editor opens editable.
    const row = deleteBtn!.closest("div.relative")!;
    const actionBtn = Array.from(
      row.querySelectorAll<HTMLButtonElement>("button"),
    ).find(
      (b) =>
        b.textContent?.trim() === "View" || b.textContent?.trim() === "Edit",
    );
    expect(actionBtn?.textContent?.trim()).toBe("Edit");
  });

  test("opening a user-owned profile sharing a managed name lands in edit mode with editable controls", async () => {
    seedInvariantProfiles();
    render(
      <Wrapper>
        <ManageProfilesModal isOpen assistantId="asst-1" onClose={() => {}} />
      </Wrapper>,
    );

    const deleteBtn = document.querySelector<HTMLButtonElement>(
      '[aria-label="Delete My OS Beta"]',
    )!;
    const row = deleteBtn.closest("div.relative")!;
    const editBtn = Array.from(
      row.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent?.trim() === "Edit")!;
    fireEvent.click(editBtn);

    // The editor opened in edit mode: the Display Name field is editable and
    // the read-only footer's Save As New affordance is absent.
    await waitFor(() => {
      expect(getInputByPlaceholder("e.g. Fast & Cheap").disabled).toBe(false);
    });
    const saveAsNew = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent?.trim() === "Save As New");
    expect(saveAsNew).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// M7 PR 5 — read-only default profiles stay locked; complete custom profiles
// round-trip with their stored (snapshot) values.
// ---------------------------------------------------------------------------

describe("ManageProfilesModal — read-only defaults and complete-override round-trip", () => {
  test("managed profiles are not draggable and their delete stays disabled", () => {
    profilesState = {
      balanced: {
        label: "Balanced",
        source: "managed",
        invariant: true,
        provider: "anthropic",
        model: "claude-opus-4-8",
      },
      "my-custom": {
        label: "My Custom",
        source: "user",
        provider: "anthropic",
        model: "claude-opus-4-8",
        provider_connection: "anthropic-personal",
      },
    };
    render(
      <Wrapper>
        <ManageProfilesModal isOpen assistantId="asst-1" onClose={() => {}} />
      </Wrapper>,
    );

    const managedDelete = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete Balanced"]',
    );
    expect(managedDelete?.disabled).toBe(true);
    expect(managedDelete?.title).toContain("cannot be deleted");

    const customDelete = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete My Custom"]',
    );
    expect(customDelete?.disabled).toBe(false);

    // Drag-reorder is a user-profile affordance only.
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>("[draggable]"),
    );
    const managedRow = rows.find((r) => r.textContent?.includes("Balanced"));
    const customRow = rows.find((r) => r.textContent?.includes("My Custom"));
    expect(managedRow?.getAttribute("draggable")).toBe("false");
    expect(customRow?.getAttribute("draggable")).toBe("true");
  });

  test("a complete custom profile opens in edit with its stored values, not blanks", async () => {
    // Post-M6, stored custom profiles are complete overrides — the editor
    // must show the baked values rather than empty inherit placeholders.
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
    render(
      <Wrapper>
        <ManageProfilesModal isOpen assistantId="asst-1" onClose={() => {}} />
      </Wrapper>,
    );

    fireEvent.click(getButton("Edit"));
    await waitFor(() => {
      expect(document.body.textContent).toContain("Max Output Tokens");
    });

    // The stored explicit budget renders as the field value — not as an
    // empty input reading "Default".
    const maxTokensInput = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="number"]'),
    ).find((el) => el.value === "12345");
    expect(maxTokensInput).toBeDefined();

    // Fields the stored profile genuinely lacks still read as defaults.
    expect(document.body.textContent).toContain("Default · 200K");
  });
});
