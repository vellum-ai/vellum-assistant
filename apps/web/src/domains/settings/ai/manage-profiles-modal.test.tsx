import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@/test-utils.js";
import userEvent, { PointerEventsCheckLevel } from "@testing-library/user-event";

import { client } from "@/generated/api/client.gen.js";
import type { ProfileEntry } from "@/domains/settings/ai/page.js";
import { ManageProfilesModal } from "@/domains/settings/ai/manage-profiles-modal.js";
import type { ProviderConnection } from "@/domains/settings/ai/provider-connections-client.js";

// Spy on client.patch and client.get directly instead of using mock.module so
// the mocks stay isolated to this file and don't pollute other test files'
// module cache. client.get is mocked because ManageProfilesModal eagerly
// fetches provider connections on open (audit finding #5 — the editor's
// per-provider Connection sub-dropdown).
const originalPatch = client.patch;
const originalGet = client.get;
const mockPatch = mock(() => Promise.resolve({ data: {} }));
const okResponse = { ok: true, status: 200 } as Response;
const mockGet = mock(() =>
  Promise.resolve({
    data: { connections: [] as ProviderConnection[] },
    response: okResponse,
  }),
);

beforeEach(() => {
  (client as unknown as Record<string, unknown>).patch = mockPatch;
  (client as unknown as Record<string, unknown>).get = mockGet;
  mockPatch.mockReset();
  mockGet.mockReset();
  mockPatch.mockImplementation(() => Promise.resolve({ data: {} }));
  mockGet.mockImplementation(() =>
    Promise.resolve({
      data: { connections: [] as ProviderConnection[] },
      response: okResponse,
    }),
  );
  document.body.removeAttribute("style");
  document.body.removeAttribute("data-scroll-locked");
});
afterEach(() => {
  (client as unknown as Record<string, unknown>).patch = originalPatch;
  (client as unknown as Record<string, unknown>).get = originalGet;
  cleanup();
});

const fastProfile: ProfileEntry = {
  source: "managed",
  label: "Fast",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
};
const preciseProfile: ProfileEntry = {
  source: "user",
  label: "Precise",
  provider: "openai",
  model: "gpt-5.5",
};
const steadyProfile: ProfileEntry = {
  source: "user",
  label: "Steady",
  provider: "gemini",
  model: "gemini-pro",
};

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    isOpen: true,
    profiles: { fast: fastProfile, precise: preciseProfile },
    profileOrder: ["fast", "precise"],
    activeProfile: null as string | null,
    assistantId: "test-assistant",
    callSiteOverrides: {} as Record<string, { profile?: string | null } | null | undefined>,
    onClose: mock(() => {}),
    onProfilesChanged: mock(() => {}),
    ...overrides,
  };
}

// Props with three profiles (two user profiles) for blocked-delete tests
function makeProps3(overrides: Record<string, unknown> = {}) {
  return {
    ...makeProps(),
    profiles: { fast: fastProfile, precise: preciseProfile, steady: steadyProfile },
    profileOrder: ["fast", "precise", "steady"],
    ...overrides,
  };
}

describe("ManageProfilesModal", () => {
  test("renders profiles in profileOrder order", () => {
    render(<ManageProfilesModal {...makeProps()} />);
    const deleteButtons = screen.getAllByRole("button", { name: /^Delete /i });
    expect(deleteButtons[0]).toHaveAttribute("aria-label", "Delete Fast");
    expect(deleteButtons[1]).toHaveAttribute("aria-label", "Delete Precise");
  });

  test("user profile shows Edit button, managed profile shows View", () => {
    render(<ManageProfilesModal {...makeProps()} />);
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "View" })).toBeTruthy();
  });

  test("managed badge is visible on managed profiles", () => {
    render(<ManageProfilesModal {...makeProps()} />);
    expect(screen.getByText("Platform")).toBeTruthy();
  });

  test("active profile delete button is disabled", () => {
    // "fast" is also managed, so its delete button is still disabled
    render(<ManageProfilesModal {...makeProps({ activeProfile: "fast" })} />);
    expect(screen.getByRole("button", { name: "Delete Fast" })).toBeDisabled();
  });

  test("non-active non-managed profile delete button is enabled", () => {
    render(<ManageProfilesModal {...makeProps({ activeProfile: "fast" })} />);
    expect(
      screen.getByRole("button", { name: "Delete Precise" }),
    ).not.toBeDisabled();
  });

  test("active non-managed profile delete button is enabled (shows reassignment modal)", () => {
    render(<ManageProfilesModal {...makeProps({ activeProfile: "precise" })} />);
    expect(
      screen.getByRole("button", { name: "Delete Precise" }),
    ).not.toBeDisabled();
  });

  test("delete fires client.patch with null tombstone and calls onProfilesChanged", async () => {
    const onProfilesChanged = mock(() => {});
    render(
      <ManageProfilesModal
        {...makeProps({ activeProfile: "fast" })}
        onProfilesChanged={onProfilesChanged}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete Precise" }));
    await waitFor(() => expect(mockPatch).toHaveBeenCalled());
    expect(mockPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { llm: { profiles: { precise: null }, profileOrder: ["fast"] } },
      }),
    );
    expect(onProfilesChanged).toHaveBeenCalledWith({
      profiles: { precise: null },
      profileOrder: ["fast"],
    });
  });

  test("delete error shows inline error message", async () => {
    mockPatch.mockImplementation(() =>
      Promise.reject(new Error("server error")),
    );
    render(<ManageProfilesModal {...makeProps({ activeProfile: "fast" })} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete Precise" }));
    await waitFor(() =>
      expect(
        screen.getByText("Failed to delete profile. Please try again."),
      ).toBeTruthy(),
    );
  });

  test("New Profile button opens the profile editor", async () => {
    render(<ManageProfilesModal {...makeProps()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "+ New Profile" }));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "New Profile" }),
      ).toBeTruthy(),
    );
  });

  // Regression: view-mode managed-profile Save must NOT delete-then-recreate.
  // The editor sends `{label, status}` as a partial entry; if the parent
  // ran its full replace cycle, the recreate step would overwrite the
  // existing profile with just those two fields, destroying provider/
  // model/advanced params on disk. Codex P1 / Devin 🔴 on PR #6543.
  test("view-mode managed Save sends a single deep-merge PATCH (no delete tombstone)", async () => {
    const onProfilesChanged = mock(() => {});
    render(
      <ManageProfilesModal
        {...makeProps({ activeProfile: "fast" })}
        onProfilesChanged={onProfilesChanged}
      />,
    );
    const user = userEvent.setup();
    // "Fast" is a managed profile per `fastProfile.source === "managed"`,
    // so the row's open-button is the lone "View" (the user-profile row
    // shows "Edit"). The button text is unscoped so we match it directly.
    await user.click(screen.getByRole("button", { name: "View" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Fast" })).toBeTruthy(),
    );
    // Toggle status (active → disabled). Two switches are on screen at
    // this point: the row's inline toggle (aria-label="Disable Fast") and
    // the editor's Active toggle. Use a regex on the editor's `label`
    // (which becomes its accessible name) to disambiguate.
    const toggle = screen.getByRole("switch", { name: /^active$/i });
    await user.click(toggle);
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: /^save$/i }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(mockPatch).toHaveBeenCalled());

    // Critical: exactly ONE patch fired. The replace path would have made
    // two (null-delete then recreate); merge mode collapses to one.
    expect(mockPatch.mock.calls.length).toBe(1);
    const [callArg] = mockPatch.mock.calls[0] as unknown as [
      { body: { llm?: { profiles?: Record<string, unknown> } } },
    ];
    const profilesBody = callArg.body.llm?.profiles ?? {};
    // The single PATCH body must be the partial entry only — no null
    // sentinel and no seed fields leaked into the body.
    expect(profilesBody.fast).not.toBeNull();
    expect(Object.keys(profilesBody.fast as Record<string, unknown>).sort()).toEqual([
      "label",
      "status",
    ]);
    // Local state update should reflect the merged record, not the partial.
    expect(onProfilesChanged).toHaveBeenCalledTimes(1);
    const [updates] = onProfilesChanged.mock.calls[0] as unknown as [
      { profiles: Record<string, ProfileEntry> },
    ];
    const merged = updates.profiles.fast;
    expect(merged).toBeDefined();
    // Seed fields (provider, model) must survive in the in-memory copy
    // because the server is deep-merging server-side too.
    expect(merged?.provider).toBe("anthropic");
    expect(merged?.model).toBe("claude-sonnet-4-6");
    expect(merged?.status).toBe("disabled");
  });
});

describe("ManageProfilesModal drag-to-reorder", () => {
  const alphaProfile: ProfileEntry = { source: "user", label: "Alpha" };
  const betaProfile: ProfileEntry = { source: "user", label: "Beta" };

  function makeDragProps(overrides: Record<string, unknown> = {}) {
    return {
      isOpen: true,
      profiles: { alpha: alphaProfile, beta: betaProfile },
      profileOrder: ["alpha", "beta"],
      activeProfile: null as string | null,
      assistantId: "test-assistant",
      callSiteOverrides: {} as Record<string, { profile?: string | null } | null | undefined>,
      onClose: mock(() => {}),
      onProfilesChanged: mock(() => {}),
      ...overrides,
    };
  }

  test("dragging row 2 before row 1 calls onProfilesChanged with reordered list", async () => {
    const onProfilesChanged = mock(() => {});
    render(<ManageProfilesModal {...makeDragProps()} onProfilesChanged={onProfilesChanged} />);

    // Both alpha and beta are user profiles → both have draggable="true"
    const draggables = document.querySelectorAll('[draggable="true"]');
    expect(draggables.length).toBeGreaterThanOrEqual(2);
    const row1 = draggables[0]!; // alpha
    const row2 = draggables[1]!; // beta

    // Drag beta to the top half of alpha (clientY=0, rect.top=0 → not "after")
    fireEvent.dragStart(row2);
    fireEvent.dragOver(row1, { clientY: 0 });
    fireEvent.drop(row1);

    await waitFor(() =>
      expect(onProfilesChanged).toHaveBeenCalledWith(
        expect.objectContaining({ profileOrder: ["beta", "alpha"] }),
      ),
    );
  });

  test("dragging a row onto itself is a no-op", async () => {
    const onProfilesChanged = mock(() => {});
    render(<ManageProfilesModal {...makeDragProps()} onProfilesChanged={onProfilesChanged} />);

    const draggables = document.querySelectorAll('[draggable="true"]');
    const row1 = draggables[0]!; // alpha

    fireEvent.dragStart(row1);
    fireEvent.dragOver(row1, { clientY: 0 });
    fireEvent.drop(row1);

    // No reorder should happen since source === target
    await waitFor(() => expect(onProfilesChanged).not.toHaveBeenCalled());
  });

  test("managed profiles do not have the draggable attribute", () => {
    render(<ManageProfilesModal {...makeProps()} />);
    // "fast" is managed — should not be draggable
    const draggables = document.querySelectorAll('[draggable="true"]');
    const labels = Array.from(draggables).map((el) => el.textContent);
    expect(labels.every((t) => !t?.includes("Fast"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Provider connections fetch (audit finding #5)
// ---------------------------------------------------------------------------

describe("ManageProfilesModal connections fetch", () => {
  test("fetches provider connections from daemon when opened", async () => {
    render(<ManageProfilesModal {...makeProps()} />);
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    // First call should target the provider-connections endpoint. The
    // mock.calls type is inferred from the parameter-less mock() factory, so
    // we read through `unknown` to access the first positional arg.
    const calls = mockGet.mock.calls as unknown as Array<Array<{ url?: string }>>;
    expect(calls[0]?.[0]?.url).toMatch(/provider-connections/);
  });

  test("tolerates a failing fetch — modal stays interactive", async () => {
    mockGet.mockImplementation(() =>
      Promise.resolve({
        data: { connections: [] as ProviderConnection[] },
        // Simulate a server failure — listConnections should throw, the
        // wrapping useEffect should swallow the error, and the modal should
        // still render its profile list.
        response: { ok: false, status: 500 } as Response,
      }),
    );
    render(<ManageProfilesModal {...makeProps()} />);
    // Wait for the failed fetch to land, then check that the rest of the
    // modal is still interactive (the profile list rendered).
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(
      screen.getByRole("button", { name: "Delete Fast" }),
    ).toBeTruthy();
  });
});

describe("ManageProfilesModal blocked-delete (active profile)", () => {
  test("clicking delete on the active non-managed profile opens the reassignment modal", async () => {
    render(<ManageProfilesModal {...makeProps3({ activeProfile: "precise" })} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete Precise" }));
    await waitFor(() =>
      expect(screen.getByText("Can't Delete Profile")).toBeTruthy(),
    );
  });

  test("blocked-delete modal shows the active profile name in summary", async () => {
    render(<ManageProfilesModal {...makeProps3({ activeProfile: "precise" })} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete Precise" }));
    await waitFor(() =>
      expect(screen.getByText(/Precise.*active profile/i)).toBeTruthy(),
    );
  });

  test("Cancel button closes the reassignment modal without deleting", async () => {
    render(<ManageProfilesModal {...makeProps3({ activeProfile: "precise" })} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete Precise" }));
    await waitFor(() => screen.getByText("Can't Delete Profile"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByText("Can't Delete Profile")).toBeNull(),
    );
    expect(mockPatch).not.toHaveBeenCalled();
  });
});

describe("ManageProfilesModal blocked-delete (call site reference)", () => {
  test("clicking delete on a call-site-referenced profile opens the reassignment modal", async () => {
    render(
      <ManageProfilesModal
        {...makeProps3()}
        callSiteOverrides={{ sidebar: { profile: "precise" } }}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete Precise" }));
    await waitFor(() =>
      expect(screen.getByText("Can't Delete Profile")).toBeTruthy(),
    );
  });

  test("the call site ID is listed in the reassignment modal", async () => {
    render(
      <ManageProfilesModal
        {...makeProps3()}
        callSiteOverrides={{ sidebar: { profile: "precise" } }}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete Precise" }));
    await waitFor(() => screen.getByText("Can't Delete Profile"));
    expect(screen.getByText("sidebar")).toBeTruthy();
  });
});

describe("ManageProfilesModal reassign-and-delete", () => {
  test("reassign and delete sends reassignment PATCH then delete PATCH", async () => {
    const onProfilesChanged = mock(() => {});
    render(
      <ManageProfilesModal
        {...makeProps3({ activeProfile: "precise" })}
        onProfilesChanged={onProfilesChanged}
      />,
    );
    // Disable pointer-events checks — Radix Dialog sets body { pointer-events: none }
    // which blocks userEvent from clicking the Dropdown listbox portaled to body.
    const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });

    // Open blocked-delete modal
    await user.click(screen.getByRole("button", { name: "Delete Precise" }));
    await waitFor(() => screen.getByText("Can't Delete Profile"));

    // Select replacement
    await user.click(screen.getByRole("combobox", { name: "Replacement profile" }));
    await user.click(screen.getByRole("option", { name: "Steady" }));

    // Confirm
    await user.click(screen.getByRole("button", { name: "Reassign and Delete" }));

    await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(2));

    // First PATCH: reassignment
    expect(mockPatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        body: { llm: { activeProfile: "steady" } },
      }),
    );
    // Second PATCH: delete tombstone
    expect(mockPatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        body: expect.objectContaining({
          llm: expect.objectContaining({ profiles: { precise: null } }),
        }),
      }),
    );

    // activeProfile update propagated to parent
    expect(onProfilesChanged).toHaveBeenCalledWith(
      expect.objectContaining({ activeProfile: "steady" }),
    );
  });

  test("Reassign and Delete button is disabled until a replacement is selected", async () => {
    render(<ManageProfilesModal {...makeProps3({ activeProfile: "precise" })} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete Precise" }));
    await waitFor(() => screen.getByText("Can't Delete Profile"));
    expect(
      screen.getByRole("button", { name: "Reassign and Delete" }),
    ).toBeDisabled();
  });

  test("reassignment PATCH failure shows inline error and does not delete", async () => {
    mockPatch.mockImplementationOnce(() => Promise.reject(new Error("server error")));
    render(
      <ManageProfilesModal
        {...makeProps3({ activeProfile: "precise" })}
      />,
    );
    const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });

    await user.click(screen.getByRole("button", { name: "Delete Precise" }));
    await waitFor(() => screen.getByText("Can't Delete Profile"));

    await user.click(screen.getByRole("combobox", { name: "Replacement profile" }));
    await user.click(screen.getByRole("option", { name: "Steady" }));
    await user.click(screen.getByRole("button", { name: "Reassign and Delete" }));

    await waitFor(() =>
      expect(
        screen.getByText("Failed to reassign references. Please try again."),
      ).toBeTruthy(),
    );
    // Only one PATCH call (the failed reassignment), no delete
    expect(mockPatch).toHaveBeenCalledTimes(1);
  });
});
