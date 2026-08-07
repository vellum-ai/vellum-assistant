/**
 * Tests for the profile delete-with-reassign flow, exercised through the
 * Profiles section so the kebab, the dialog, and the mutations run as a user
 * would drive them.
 *
 * The load-bearing behavior: a profile's schedules are found before it is
 * deleted, named in the dialog, and moved onto the replacement first. A
 * schedule move that fails must leave the profile in place.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type {
  ConfigGetResponse,
  ProfileEntry,
} from "@/generated/daemon/types.gen";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

let configPatchBodies: unknown[] = [];
let reassignBodies: Array<{ from: string; to: string }> = [];
let reassignFails = false;
let scheduleScanFails = false;
let profilesState: Record<string, ProfileEntry> = {};
let activeProfileState: string | null = null;
let schedulesByProfile: Record<
  string,
  Array<{ name: string; isDeferred: boolean }>
> = {};
let scheduleQueries: Array<Record<string, string> | undefined> = [];
/** When true, the scan parks until `releaseScheduleScan()` is called. */
let holdScheduleScan = false;
let releaseScheduleScan: (() => void) | null = null;

function configPayload(): ConfigGetResponse {
  return {
    llm: {
      profiles: profilesState,
      profileOrder: Object.keys(profilesState),
      activeProfile: activeProfileState,
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
  configGet: async () => ({ data: configPayload() }),
  configPatch: async (options?: { body?: unknown }) => {
    configPatchBodies.push(options?.body);
    return { data: configPayload() };
  },
  schedulesGet: async (options?: {
    query?: { inference_profile?: string; include_all?: string };
  }) => {
    scheduleQueries.push(options?.query);
    if (holdScheduleScan) {
      await new Promise<void>((resolve) => {
        releaseScheduleScan = resolve;
      });
    }
    if (scheduleScanFails) {
      throw new Error("network down");
    }
    return {
      data: {
        schedules:
          schedulesByProfile[options?.query?.inference_profile ?? ""] ?? [],
      },
    };
  },
  schedulesReassignprofilePost: async (options?: {
    body?: { from: string; to: string };
  }) => {
    if (reassignFails) {
      return {
        data: undefined,
        error: { detail: "profile is gone" },
        response: new Response(null, { status: 400 }),
      };
    }
    reassignBodies.push(options!.body!);
    return {
      data: { reassigned: options!.body ? 1 : 0 },
      error: undefined,
      response: new Response(null, { status: 200 }),
    };
  },
}));

const { configGetQueryKey } = await import(
  "@/generated/daemon/@tanstack/react-query.gen"
);
const { ProfilesSection } = await import(
  "@/domains/settings/ai/profiles-section"
);
const { useAssistantIdentityStore } = await import(
  "@/stores/assistant-identity-store"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  client.setQueryData(
    configGetQueryKey({ path: { assistant_id: "asst-1" } }),
    configPayload(),
  );
  return createElement(QueryClientProvider, { client }, children);
}

function renderSection() {
  return render(
    <Wrapper>
      <ProfilesSection
        assistantId="asst-1"
        config={configPayload()}
        selectedProfileName={null}
        onOpenProfile={() => {}}
        onCreateProfile={() => {}}
        onProfileDeleted={() => {}}
      />
    </Wrapper>,
  );
}

async function clickDelete(profileLabel: string): Promise<void> {
  const trigger = document.querySelector<HTMLButtonElement>(
    `button[aria-label="Actions for ${profileLabel}"]`,
  );
  if (!trigger) {
    throw new Error(`expected a kebab trigger for "${profileLabel}"`);
  }
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
  const item = Array.from(menu.querySelectorAll('[role="menuitem"]')).find(
    (el) => el.textContent?.trim() === "Delete",
  );
  if (!item) {
    throw new Error("expected a Delete menu item");
  }
  fireEvent.click(item);
}

async function waitForDialog(): Promise<void> {
  await waitFor(() => {
    expect(document.body.textContent).toContain("Choose a Replacement Profile");
  });
}

function replacementTrigger(): HTMLButtonElement {
  const trigger = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Replacement profile"]',
  );
  if (!trigger) {
    throw new Error("expected the replacement picker");
  }
  return trigger;
}

/** The label the picker currently shows, i.e. the selected replacement. */
function selectedReplacementLabel(): string {
  return replacementTrigger().textContent?.trim() ?? "";
}

/** Opens the picker and returns every offered option label, in order. */
async function replacementOptionLabels(): Promise<string[]> {
  fireEvent.click(replacementTrigger());
  const options = await waitFor(() => {
    const found = document.querySelectorAll<HTMLElement>('[role="option"]');
    if (found.length === 0) {
      throw new Error("picker did not open");
    }
    return found;
  });
  return Array.from(options).map((o) => o.textContent?.trim() ?? "");
}

async function chooseReplacement(label: string): Promise<void> {
  await replacementOptionLabels();
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((o) => o.textContent?.trim() === label);
  if (!option) {
    throw new Error(`expected a replacement option "${label}"`);
  }
  fireEvent.click(option);
}

function confirmButton(): HTMLButtonElement {
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent?.includes("Reassign and Delete"));
  if (!button) {
    throw new Error("expected the confirm button");
  }
  return button;
}

beforeEach(() => {
  useAssistantIdentityStore
    .getState()
    .setIdentity("Test", "0.12.0", "asst-1");
  configPatchBodies = [];
  reassignBodies = [];
  reassignFails = false;
  scheduleScanFails = false;
  activeProfileState = "balanced";
  schedulesByProfile = {};
  scheduleQueries = [];
  holdScheduleScan = false;
  releaseScheduleScan = null;
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
    },
    "other-custom": {
      label: "Other Custom",
      source: "user",
      provider: "anthropic",
      model: "claude-opus-4-8",
    },
  };
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("profile delete flow - schedule scan", () => {
  test("a profile with no references and no schedules deletes straight away", async () => {
    renderSection();
    await clickDelete("My Custom");

    await waitFor(() => {
      expect(configPatchBodies.length).toBe(1);
    });
    expect(configPatchBodies[0]).toEqual({
      llm: {
        profiles: { "my-custom": null },
        profileOrder: ["balanced", "other-custom"],
      },
    });
    expect(document.body.textContent).not.toContain(
      "Choose a Replacement Profile",
    );
  });

  test("schedules pinned to the profile open the dialog and are named", async () => {
    schedulesByProfile["my-custom"] = [
      { name: "Morning digest", isDeferred: false },
      { name: "Inbox triage", isDeferred: false },
    ];
    renderSection();
    await clickDelete("My Custom");
    await waitForDialog();

    expect(document.body.textContent).toContain("runs 2 schedules");
    expect(document.body.textContent).toContain("Morning digest");
    expect(document.body.textContent).toContain("Inbox triage");
    expect(configPatchBodies.length).toBe(0);
  });

  test("a long schedule list is truncated with an 'and N more' tail", async () => {
    schedulesByProfile["my-custom"] = Array.from({ length: 12 }, (_, i) => ({
      name: `Schedule ${i + 1}`,
      isDeferred: false,
    }));
    renderSection();
    await clickDelete("My Custom");
    await waitForDialog();

    expect(document.body.textContent).toContain("runs 12 schedules");
    expect(document.body.textContent).toContain("Schedule 5");
    expect(document.body.textContent).not.toContain("Schedule 6");
    expect(document.body.textContent).toContain("and 7 more");
  });

  test("the scan asks for hidden rows so its count matches what moves", async () => {
    renderSection();
    await clickDelete("My Custom");

    await waitFor(() => {
      expect(scheduleQueries.length).toBe(1);
    });
    expect(scheduleQueries[0]).toEqual({
      inference_profile: "my-custom",
      include_all: "true",
    });
  });

  test("deferred reminders are counted alongside the named schedules", async () => {
    schedulesByProfile["my-custom"] = [
      { name: "Morning digest", isDeferred: false },
      { name: "Deferred wake", isDeferred: true },
      { name: "Deferred wake", isDeferred: true },
    ];
    renderSection();
    await clickDelete("My Custom");
    await waitForDialog();

    expect(document.body.textContent).toContain(
      "runs 1 schedule and 2 reminders",
    );
    // Reminders share one generated name, so they are counted, never listed.
    expect(document.body.textContent).toContain("Morning digest");
    expect(document.body.textContent).not.toContain("Deferred wake");
  });

  test("deferred reminders alone are enough to open the dialog", async () => {
    schedulesByProfile["my-custom"] = [
      { name: "Deferred wake", isDeferred: true },
    ];
    renderSection();
    await clickDelete("My Custom");
    await waitForDialog();

    expect(document.body.textContent).toContain("runs 1 reminder");
    expect(configPatchBodies.length).toBe(0);

    fireEvent.click(confirmButton());
    await waitFor(() => {
      expect(configPatchBodies.length).toBe(1);
    });
    expect(reassignBodies).toEqual([{ from: "my-custom", to: "balanced" }]);
  });

  test("a failed schedule scan warns instead of deleting blind", async () => {
    scheduleScanFails = true;
    renderSection();
    await clickDelete("My Custom");
    await waitForDialog();

    expect(document.body.textContent).toContain(
      "We could not check which schedules use this profile",
    );
    expect(configPatchBodies.length).toBe(0);
  });
});

describe("profile delete flow - pending state", () => {
  test("the row and its kebab go inert while the scan is in flight", async () => {
    holdScheduleScan = true;
    renderSection();
    await clickDelete("My Custom");

    const kebab = await waitFor(() => {
      const el = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Actions for My Custom"]',
      );
      if (!el?.disabled) {
        throw new Error("kebab is not disabled yet");
      }
      return el;
    });
    const row = kebab.closest('[data-slot="list-row"]');
    expect(row?.className).toContain("opacity-60");

    // Only the profile being deleted goes inert.
    const otherKebab = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Actions for Other Custom"]',
    );
    expect(otherKebab?.disabled).toBe(false);

    act(() => {
      releaseScheduleScan?.();
    });
    await waitFor(() => {
      expect(
        document.querySelector<HTMLButtonElement>(
          'button[aria-label="Actions for Other Custom"]',
        ),
      ).not.toBeNull();
      expect(configPatchBodies.length).toBe(1);
    });
  });
});

describe("profile delete flow - replacement preselection", () => {
  test("the current default profile is preselected", async () => {
    schedulesByProfile["my-custom"] = [
      { name: "Morning digest", isDeferred: false },
    ];
    renderSection();
    await clickDelete("My Custom");
    await waitForDialog();

    expect(selectedReplacementLabel()).toBe("Balanced");
    expect(confirmButton().disabled).toBe(false);
  });

  test("the managed default stays offered alongside the user profiles", async () => {
    schedulesByProfile["my-custom"] = [
      { name: "Morning digest", isDeferred: false },
    ];
    renderSection();
    await clickDelete("My Custom");
    await waitForDialog();

    expect(await replacementOptionLabels()).toEqual([
      "Balanced",
      "Other Custom",
    ]);
  });

  test("managed profiles that are not the default are offered too", async () => {
    profilesState["quality"] = {
      label: "Quality",
      source: "managed",
      invariant: true,
      provider: "anthropic",
      model: "claude-opus-4-8",
    };
    schedulesByProfile["my-custom"] = [
      { name: "Morning digest", isDeferred: false },
    ];
    renderSection();
    await clickDelete("My Custom");
    await waitForDialog();

    expect(await replacementOptionLabels()).toEqual([
      "Balanced",
      "Other Custom",
      "Quality",
    ]);
  });

  test("deleting the default preselects the user's own profile over managed ones", async () => {
    profilesState["quality"] = {
      label: "Quality",
      source: "managed",
      invariant: true,
      provider: "anthropic",
      model: "claude-opus-4-8",
    };
    activeProfileState = "my-custom";
    renderSection();
    await clickDelete("My Custom");
    await waitForDialog();

    expect(await replacementOptionLabels()).toEqual([
      "Balanced",
      "Other Custom",
      "Quality",
    ]);
    expect(selectedReplacementLabel()).toBe("Other Custom");
  });
});

describe("profile delete flow - disabled replacements", () => {
  beforeEach(() => {
    profilesState["retired"] = {
      label: "Retired",
      source: "user",
      status: "disabled",
      provider: "anthropic",
      model: "claude-opus-4-8",
    };
  });

  test("a disabled profile cannot be chosen when schedules are moving", async () => {
    schedulesByProfile["my-custom"] = [
      { name: "Morning digest", isDeferred: false },
    ];
    renderSection();
    await clickDelete("My Custom");
    await waitForDialog();

    expect(await replacementOptionLabels()).toEqual([
      "Balanced",
      "Other Custom",
      "Retired (Disabled)",
    ]);
    const retired = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((o) => o.textContent?.trim() === "Retired (Disabled)");
    expect(retired?.getAttribute("aria-disabled")).toBe("true");

    // Clicking it is inert, so the preselected replacement survives.
    fireEvent.click(retired!);
    expect(selectedReplacementLabel()).toBe("Balanced");
  });

  test("a disabled profile stays selectable when no schedule moves", async () => {
    // Deleting the default opens the dialog with no schedules in scope, so
    // nothing goes through the reassign endpoint and its refusal of disabled
    // targets does not apply.
    activeProfileState = "my-custom";
    renderSection();
    await clickDelete("My Custom");
    await waitForDialog();

    await replacementOptionLabels();
    const option = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((o) => o.textContent?.trim() === "Retired (Disabled)");
    // Radix omits `aria-disabled` on enabled options rather than setting it
    // to "false", so assert it is not disabled. The click below is the real
    // proof that a disabled profile stays choosable as a replacement.
    expect(option?.getAttribute("aria-disabled")).not.toBe("true");

    fireEvent.click(option!);
    expect(selectedReplacementLabel()).toBe("Retired (Disabled)");
  });

  test("the preselection skips a disabled profile when schedules are moving", async () => {
    // No active default to fall back on, so preselection walks the list and
    // must not land on the disabled entry.
    activeProfileState = null;
    profilesState = {
      retired: profilesState.retired!,
      "my-custom": profilesState["my-custom"]!,
      "other-custom": profilesState["other-custom"]!,
    };
    schedulesByProfile["my-custom"] = [
      { name: "Morning digest", isDeferred: false },
    ];
    renderSection();
    await clickDelete("My Custom");
    await waitForDialog();

    expect(selectedReplacementLabel()).toBe("Other Custom");
  });
});

describe("profile delete flow - reassign then delete", () => {
  test("schedules move to the replacement before the profile is deleted", async () => {
    schedulesByProfile["my-custom"] = [
      { name: "Morning digest", isDeferred: false },
    ];
    renderSection();
    await clickDelete("My Custom");
    await waitForDialog();

    await chooseReplacement("Other Custom");
    fireEvent.click(confirmButton());

    await waitFor(() => {
      expect(configPatchBodies.length).toBe(1);
    });
    expect(reassignBodies).toEqual([{ from: "my-custom", to: "other-custom" }]);
    expect(configPatchBodies[0]).toEqual({
      llm: {
        profiles: { "my-custom": null },
        profileOrder: ["balanced", "other-custom"],
      },
    });
  });

  test("a failed schedule move blocks the delete and says why", async () => {
    schedulesByProfile["my-custom"] = [
      { name: "Morning digest", isDeferred: false },
    ];
    reassignFails = true;
    renderSection();
    await clickDelete("My Custom");
    await waitForDialog();

    fireEvent.click(confirmButton());

    await waitFor(() => {
      // The endpoint's own reason, not a fixed "something failed" string: on a
      // destructive flow the user has to know what to change.
      expect(document.body.textContent).toContain(
        "profile is gone. The profile was not deleted.",
      );
    });
    expect(configPatchBodies.length).toBe(0);
    expect(document.body.textContent).toContain("Choose a Replacement Profile");
  });
});

