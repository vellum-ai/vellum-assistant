/**
 * Tests for `ProfilesSection` - the inline Profiles list of the Language
 * Model card.
 *
 * Invariant (managed) profiles expose enable-only actions and no Delete,
 * user profiles get the full kebab, the status re-enable PATCHes exactly
 * `{status: "active"}`, and the Default chip tracks `llm.activeProfile`.
 *
 * The advisor selection is not surfaced here at all - it lives in the
 * Action Overrides panel. `llm.advisorProfile` still appears below because
 * deleting the profile it points at must clear the reference in the same
 * patch, which is this section's job.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type {
  ConfigGetResponse,
  ProfileEntry,
} from "@/generated/daemon/types.gen";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

let configPatchBodies: unknown[] = [];
let profilesState: Record<string, ProfileEntry> = {};
let activeProfileState: string | null = null;
let advisorProfileState: string | null = null;

function configPayload(): ConfigGetResponse {
  return {
    llm: {
      profiles: profilesState,
      profileOrder: Object.keys(profilesState),
      activeProfile: activeProfileState,
      advisorProfile: advisorProfileState,
      callSites: {},
    },
  } as ConfigGetResponse;
}

mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { success: () => {}, error: () => {} },
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
}));

// The effective-catalog gate reads the identity store; leave the version
// unknown so the section exercises the config-derived fallback path
// (deterministic without mocking the inference/profiles route).
const { configGetQueryKey } = await import(
  "@/generated/daemon/@tanstack/react-query.gen"
);
const { ProfilesSection } = await import(
  "@/domains/settings/ai/profiles-section"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  const queryKey = configGetQueryKey({ path: { assistant_id: "asst-1" } });
  client.setQueryData(queryKey, configPayload());
  return createElement(QueryClientProvider, { client }, children);
}

function renderSection(
  overrides: Partial<Parameters<typeof ProfilesSection>[0]> = {},
) {
  return render(
    <Wrapper>
      <ProfilesSection
        assistantId="asst-1"
        config={configPayload()}
        selectedProfileName={null}
        onOpenProfile={() => {}}
        onCreateProfile={() => {}}
        onProfileDeleted={() => {}}
        {...overrides}
      />
    </Wrapper>,
  );
}

async function openKebab(profileLabel: string): Promise<HTMLElement> {
  const trigger = document.querySelector<HTMLButtonElement>(
    `button[aria-label="Actions for ${profileLabel}"]`,
  );
  if (!trigger) {
    throw new Error(`expected a kebab trigger for "${profileLabel}"`);
  }
  // Radix DropdownMenu opens on pointerdown.
  act(() => {
    trigger.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    trigger.click();
  });
  const menu = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('[role="menu"]');
    if (!el) {
      throw new Error("menu did not open");
    }
    return el;
  });
  return menu;
}

function menuItems(menu: HTMLElement): string[] {
  return Array.from(menu.querySelectorAll('[role="menuitem"]')).map(
    (el) => el.textContent?.trim() ?? "",
  );
}

function clickMenuItem(menu: HTMLElement, label: string): void {
  const item = Array.from(menu.querySelectorAll('[role="menuitem"]')).find(
    (el) => el.textContent?.trim() === label,
  );
  if (!item) {
    throw new Error(`expected menu item "${label}"`);
  }
  fireEvent.click(item);
}

function seedProfiles() {
  profilesState = {
    balanced: {
      label: "Balanced",
      source: "managed",
      invariant: true,
      provider: "anthropic",
      model: "claude-opus-4-8",
    },
    "speed-tier": {
      label: "Speed",
      source: "managed",
      invariant: true,
      status: "disabled",
      provider: "anthropic",
      model: "claude-haiku-4-5",
    },
    "my-custom": {
      label: "My Custom",
      source: "user",
      provider: "anthropic",
      model: "claude-opus-4-8",
    },
  };
}

beforeEach(() => {
  configPatchBodies = [];
  activeProfileState = null;
  advisorProfileState = null;
  seedProfiles();
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProfilesSection - chips", () => {
  test("the Default chip tracks llm.activeProfile", () => {
    activeProfileState = "balanced";
    renderSection();

    const rows = Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="list-row"]'),
    );
    const balancedRow = rows.find((r) => r.textContent?.includes("Balanced"));
    const customRow = rows.find((r) => r.textContent?.includes("My Custom"));
    expect(balancedRow?.textContent).toContain("Default");
    expect(customRow?.textContent).not.toContain("Default");
  });

  test("no row carries an Advisor chip, whatever llm.advisorProfile says", () => {
    activeProfileState = "balanced";
    advisorProfileState = "my-custom";
    renderSection();

    expect(document.body.textContent).not.toContain("Advisor");
  });

  test("a disabled profile shows the Disabled chip", () => {
    renderSection();
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="list-row"]'),
    );
    const speedRow = rows.find((r) => r.textContent?.includes("Speed"));
    expect(speedRow?.textContent).toContain("Disabled");
  });

  test("managed rows carry the inline Managed by Vellum line", () => {
    renderSection();
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="list-row"]'),
    );
    const balancedRow = rows.find((r) => r.textContent?.includes("Balanced"));
    const customRow = rows.find((r) => r.textContent?.includes("My Custom"));
    expect(balancedRow?.textContent).toContain("Managed by Vellum");
    expect(customRow?.textContent).not.toContain("Managed by Vellum");
  });
});

describe("ProfilesSection - kebab menus", () => {
  test("an active managed profile offers View/Make Default but no Disable or Delete", async () => {
    renderSection();
    const menu = await openKebab("Balanced");
    const items = menuItems(menu);
    expect(items).toContain("View");
    expect(items).toContain("Make Default");
    expect(items).not.toContain("Make Advisor");
    expect(items).not.toContain("Disable");
    expect(items).not.toContain("Delete");
    expect(items).not.toContain("Edit");
  });

  test("a disabled managed profile offers Enable and hides Make Default", async () => {
    renderSection();
    const menu = await openKebab("Speed");
    const items = menuItems(menu);
    expect(items).toContain("Enable");
    expect(items).not.toContain("Disable");
    expect(items).not.toContain("Make Default");
    expect(items).not.toContain("Delete");
  });

  test("a user profile offers Edit/Disable/Delete", async () => {
    renderSection();
    const menu = await openKebab("My Custom");
    const items = menuItems(menu);
    expect(items).toContain("Edit");
    expect(items).toContain("Disable");
    expect(items).toContain("Delete");
    expect(items).not.toContain("View");
  });

  test("the current default profile hides Make Default and offers no advisor actions", async () => {
    activeProfileState = "my-custom";
    advisorProfileState = "my-custom";
    renderSection();
    const menu = await openKebab("My Custom");
    const items = menuItems(menu);
    expect(items).not.toContain("Make Default");
    expect(items).not.toContain("Make Advisor");
    expect(items).not.toContain("Remove as Advisor");
  });

  test("re-enabling a disabled invariant profile PATCHes status:'active' and nothing else", async () => {
    renderSection();
    const menu = await openKebab("Speed");
    clickMenuItem(menu, "Enable");

    await waitFor(() => {
      expect(configPatchBodies.length).toBeGreaterThan(0);
    });
    expect(configPatchBodies).toEqual([
      { llm: { profiles: { "speed-tier": { status: "active" } } } },
    ]);
  });

  test("Make Default PATCHes llm.activeProfile", async () => {
    renderSection();
    const menu = await openKebab("My Custom");
    clickMenuItem(menu, "Make Default");

    await waitFor(() => {
      expect(configPatchBodies).toEqual([
        { llm: { activeProfile: "my-custom" } },
      ]);
    });
  });

  test("deleting the advisor profile clears the advisor reference in the same patch", async () => {
    advisorProfileState = "my-custom";
    renderSection();
    const menu = await openKebab("My Custom");
    clickMenuItem(menu, "Delete");

    await waitFor(() => {
      expect(configPatchBodies.length).toBe(1);
    });
    expect(configPatchBodies[0]).toEqual({
      llm: {
        profiles: { "my-custom": null },
        profileOrder: ["balanced", "speed-tier"],
        advisorProfile: null,
      },
    });
  });

  test("deleting the active profile routes through the reassign dialog instead of deleting", async () => {
    activeProfileState = "my-custom";
    renderSection();
    const menu = await openKebab("My Custom");
    clickMenuItem(menu, "Delete");

    await waitFor(() => {
      expect(document.body.textContent).toContain("Can't Delete Profile");
    });
    expect(configPatchBodies.length).toBe(0);
  });
});

describe("ProfilesSection - row interactions", () => {
  test("clicking a row opens its profile", () => {
    const opened: string[] = [];
    renderSection({ onOpenProfile: (name) => opened.push(name) });

    const rowButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Open profile Balanced"]',
    );
    expect(rowButton).not.toBeNull();
    fireEvent.click(rowButton!);
    expect(opened).toEqual(["balanced"]);
  });

  test("rows are not draggable (reorder retired with the modal)", () => {
    renderSection();
    expect(document.querySelector('[draggable="true"]')).toBeNull();
  });

  // The row actions and the create panel read config state (selections,
  // call-site references, profileOrder), so the section must not expose
  // them while the config query is still loading - even if the
  // effective-catalog query has already produced rows.
  test("holds rows back and disables Create Profile until config loads", () => {
    renderSection({ config: undefined });
    expect(document.querySelector('[data-slot="list-row"]')).toBeNull();
    expect(document.body.textContent).toContain("Loading profiles…");
    const createButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent?.includes("Create Profile"));
    expect(createButton?.disabled).toBe(true);
  });
});
