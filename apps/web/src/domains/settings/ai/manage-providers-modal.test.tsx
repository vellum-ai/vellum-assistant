import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@/test-utils.js";
import userEvent, { PointerEventsCheckLevel } from "@testing-library/user-event";

import { client } from "@/generated/api/client.gen.js";
import { ManageProvidersModal } from "@/domains/settings/ai/manage-providers-modal.js";
import type { ProviderConnection } from "@/domains/settings/ai/provider-connections-client.js";

const originalGet = client.get;
const originalDelete = client.delete;
const okResponse = { ok: true, status: 200 } as Response;
const mockGet = mock(() => Promise.resolve({ data: { connections: [] as ProviderConnection[] }, response: okResponse }));
const mockDelete = mock(() => Promise.resolve({ data: {}, response: { ok: true, status: 204 } as Response }));

beforeEach(() => {
  (client as unknown as Record<string, unknown>).get = mockGet;
  (client as unknown as Record<string, unknown>).delete = mockDelete;
  mockGet.mockReset();
  mockDelete.mockReset();
  mockGet.mockImplementation(() => Promise.resolve({ data: { connections: [] as ProviderConnection[] }, response: okResponse }));
  mockDelete.mockImplementation(() => Promise.resolve({ data: {}, response: { ok: true, status: 204 } as Response }));
  document.body.removeAttribute("style");
  document.body.removeAttribute("data-scroll-locked");
});
afterEach(() => {
  (client as unknown as Record<string, unknown>).get = originalGet;
  (client as unknown as Record<string, unknown>).delete = originalDelete;
  cleanup();
});

const fakeConnection: ProviderConnection = {
  name: "my-anthropic",
  provider: "anthropic",
  auth: { type: "api_key", credential: "credential/anthropic/key" },
  status: "active",
  label: null,
  createdAt: 0,
  updatedAt: 0,
  baseUrl: null,
  models: null,
};

const disabledConnection: ProviderConnection = {
  name: "my-disabled",
  provider: "openai",
  auth: { type: "platform" },
  status: "disabled",
  label: "My Disabled Key",
  createdAt: 0,
  updatedAt: 0,
  baseUrl: null,
  models: null,
};

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    isOpen: true,
    assistantId: "test-assistant",
    onClose: mock(() => {}),
    ...overrides,
  };
}

describe("ManageProvidersModal", () => {
  test("shows loading skeletons while fetching", () => {
    // Never resolves so we stay in loading state
    mockGet.mockImplementation(() => new Promise(() => {}));
    render(<ManageProvidersModal {...makeProps()} />);
    // Should render animated pulse placeholders (no connection rows)
    expect(screen.queryByText("my-anthropic")).toBeNull();
  });

  test("shows empty state when there are no connections", async () => {
    mockGet.mockImplementation(() =>
      Promise.resolve({ data: { connections: [] }, response: okResponse }),
    );
    render(<ManageProvidersModal {...makeProps()} />);
    await waitFor(() =>
      expect(screen.getByText(/no connections yet/i)).toBeTruthy(),
    );
  });

  test("renders connection name and provider info", async () => {
    mockGet.mockImplementation(() =>
      Promise.resolve({ data: { connections: [fakeConnection] }, response: okResponse }),
    );
    render(<ManageProvidersModal {...makeProps()} />);
    await waitFor(() =>
      expect(screen.getByText("my-anthropic")).toBeTruthy(),
    );
    expect(screen.getByText(/Anthropic/)).toBeTruthy();
    expect(screen.getByText(/API key/)).toBeTruthy();
  });

  test("renders Edit and Delete buttons for each connection", async () => {
    mockGet.mockImplementation(() =>
      Promise.resolve({ data: { connections: [fakeConnection] }, response: okResponse }),
    );
    render(<ManageProvidersModal {...makeProps()} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(),
    );
    expect(
      screen.getByRole("button", { name: "Delete my-anthropic" }),
    ).toBeTruthy();
  });

  test("shows label as primary text and key (no @ prefix) as secondary when label is set", async () => {
    mockGet.mockImplementation(() =>
      Promise.resolve({ data: { connections: [disabledConnection] }, response: okResponse }),
    );
    render(<ManageProvidersModal {...makeProps()} />);
    await waitFor(() =>
      expect(screen.getByText("My Disabled Key")).toBeTruthy(),
    );
    // The @ prefix was removed — the name is now shown without it.
    expect(screen.getByText(/my-disabled/)).toBeTruthy();
    expect(screen.queryByText(/@my-disabled/)).toBeNull();
  });

  test("shows status toggle in disabled state for disabled connections", async () => {
    mockGet.mockImplementation(() =>
      Promise.resolve({ data: { connections: [disabledConnection] }, response: okResponse }),
    );
    render(<ManageProvidersModal {...makeProps()} />);
    await waitFor(() =>
      expect(screen.getByText("My Disabled Key")).toBeTruthy(),
    );
    // The disabled connection row renders a Toggle (role="switch") with a
    // verb-driven aria-label naming the action it would take ("Enable …").
    // Replaces the previous static "Disabled" badge.
    const toggle = screen.getByRole("switch", {
      name: "Enable My Disabled Key",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  test("all connections appear in management list (no filtering by status)", async () => {
    mockGet.mockImplementation(() =>
      Promise.resolve({
        data: { connections: [fakeConnection, disabledConnection] },
        response: okResponse,
      }),
    );
    render(<ManageProvidersModal {...makeProps()} />);
    await waitFor(() =>
      expect(screen.getByText("my-anthropic")).toBeTruthy(),
    );
    expect(screen.getByText("My Disabled Key")).toBeTruthy();
  });

  test("removes connection from list after successful delete", async () => {
    const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
    mockGet.mockImplementation(() =>
      Promise.resolve({ data: { connections: [fakeConnection] }, response: okResponse }),
    );
    mockDelete.mockImplementation(() =>
      Promise.resolve({ data: {}, response: { ok: true, status: 204 } as Response }),
    );
    render(<ManageProvidersModal {...makeProps()} />);
    await waitFor(() =>
      expect(screen.getByText("my-anthropic")).toBeTruthy(),
    );
    await user.click(screen.getByRole("button", { name: "Delete my-anthropic" }));
    await waitFor(() =>
      expect(screen.queryByText("my-anthropic")).toBeNull(),
    );
  });

  test("shows inline error on 409 conflict during delete", async () => {
    const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
    mockGet.mockImplementation(() =>
      Promise.resolve({ data: { connections: [fakeConnection] }, response: okResponse }),
    );
    mockDelete.mockImplementation(() =>
      Promise.resolve({ data: {}, response: { ok: false, status: 409 } as Response }),
    );
    render(<ManageProvidersModal {...makeProps()} />);
    await waitFor(() =>
      expect(screen.getByText("my-anthropic")).toBeTruthy(),
    );
    await user.click(screen.getByRole("button", { name: "Delete my-anthropic" }));
    await waitFor(() =>
      expect(screen.getByText(/connection is in use/i)).toBeTruthy(),
    );
  });

  test("New Connection button is present in the footer", async () => {
    render(<ManageProvidersModal {...makeProps()} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /\+ new connection/i })).toBeTruthy(),
    );
  });

  // Managed connections (anthropic-managed / openai-managed / gemini-managed)
  // are seeded + write-protected by the daemon. The daemon response flags
  // them with `isManaged: true`. The UI mirrors that contract: Platform badge
  // + View button + disabled Delete.
  describe("managed connections", () => {
    const managedConnection: ProviderConnection = {
      name: "anthropic-managed",
      provider: "anthropic",
      auth: { type: "platform" },
      status: "active",
      label: null,
      createdAt: 0,
      updatedAt: 0,
      baseUrl: null,
      models: null,
      isManaged: true,
    };

    test("shows Platform badge next to managed connection name", async () => {
      mockGet.mockImplementation(() =>
        Promise.resolve({
          data: { connections: [managedConnection] },
          response: okResponse,
        }),
      );
      render(<ManageProvidersModal {...makeProps()} />);
      await waitFor(() =>
        expect(screen.getByText("anthropic-managed")).toBeTruthy(),
      );
      expect(screen.getByText("Platform")).toBeTruthy();
    });

    test("shows Edit button (not View) for managed connection", async () => {
      mockGet.mockImplementation(() =>
        Promise.resolve({
          data: { connections: [managedConnection] },
          response: okResponse,
        }),
      );
      render(<ManageProvidersModal {...makeProps()} />);
      await waitFor(() =>
        expect(screen.getByText("anthropic-managed")).toBeTruthy(),
      );
      // Managed connections now open in managed-edit mode, not view-only.
      // The row button still reads "Edit" for consistency with non-managed rows.
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "View" })).toBeNull();
    });

    test("Delete button is disabled for managed connection", async () => {
      mockGet.mockImplementation(() =>
        Promise.resolve({
          data: { connections: [managedConnection] },
          response: okResponse,
        }),
      );
      render(<ManageProvidersModal {...makeProps()} />);
      await waitFor(() =>
        expect(screen.getByText("anthropic-managed")).toBeTruthy(),
      );
      expect(
        screen.getByRole("button", { name: "Delete anthropic-managed" }),
      ).toBeDisabled();
    });

    test("regular Edit / Delete still work for non-managed connections", async () => {
      mockGet.mockImplementation(() =>
        Promise.resolve({
          data: { connections: [fakeConnection, managedConnection] },
          response: okResponse,
        }),
      );
      render(<ManageProvidersModal {...makeProps()} />);
      await waitFor(() =>
        expect(screen.getByText("my-anthropic")).toBeTruthy(),
      );
      // Both rows now render an "Edit" button (managed and non-managed) —
      // since managed connections open in managed-edit mode rather than
      // view-only mode. Verify both rows have one.
      expect(screen.getAllByRole("button", { name: "Edit" }).length).toBe(2);
      // Delete button for non-managed row is enabled (managed row's Delete
      // is disabled — covered by the test above).
      expect(
        screen.getByRole("button", { name: "Delete my-anthropic" }),
      ).not.toBeDisabled();
    });
  });

  // ---------------------------------------------------------------------------
  // Master/detail flow: the editor opens INSIDE the same modal frame rather
  // than as a stacked second modal. The list view and the editor view swap
  // inside a single `Modal.Root` (mirrors the macOS `ProvidersSheet` flow).
  // ---------------------------------------------------------------------------
  describe("master/detail flow", () => {
    test("clicking Edit on a row swaps the list view for the editor inside the same modal", async () => {
      mockGet.mockImplementation(() =>
        Promise.resolve({
          data: { connections: [fakeConnection] },
          response: okResponse,
        }),
      );
      const user = userEvent.setup({
        pointerEventsCheck: PointerEventsCheckLevel.Never,
      });
      render(<ManageProvidersModal {...makeProps()} />);
      await waitFor(() =>
        expect(screen.getByText("my-anthropic")).toBeTruthy(),
      );
      // Before: list view is shown; the editor title is absent.
      expect(screen.getByRole("heading", { name: "Provider Connections" })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: /edit connection/i })).toBeNull();

      await user.click(screen.getByRole("button", { name: "Edit" }));

      // After: editor view replaces the list view inside the same modal.
      // Only one dialog is in the DOM (no stacked modals).
      await waitFor(() =>
        expect(screen.getByRole("heading", { name: /edit connection/i })).toBeTruthy(),
      );
      expect(screen.queryByRole("heading", { name: "Provider Connections" })).toBeNull();
      expect(screen.getAllByRole("dialog").length).toBe(1);
    });

    test("clicking Cancel in the editor returns to the list view without closing the modal", async () => {
      mockGet.mockImplementation(() =>
        Promise.resolve({
          data: { connections: [fakeConnection] },
          response: okResponse,
        }),
      );
      const user = userEvent.setup({
        pointerEventsCheck: PointerEventsCheckLevel.Never,
      });
      const onClose = mock(() => {});
      render(<ManageProvidersModal {...makeProps({ onClose })} />);
      await waitFor(() =>
        expect(screen.getByText("my-anthropic")).toBeTruthy(),
      );
      await user.click(screen.getByRole("button", { name: "Edit" }));
      await waitFor(() =>
        expect(screen.getByRole("heading", { name: /edit connection/i })).toBeTruthy(),
      );

      await user.click(screen.getByRole("button", { name: "Cancel" }));

      // Back to list view; outer modal stays open (onClose not called).
      await waitFor(() =>
        expect(screen.getByRole("heading", { name: "Provider Connections" })).toBeTruthy(),
      );
      expect(screen.queryByRole("heading", { name: /edit connection/i })).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
    });

    test("clicking + New Connection opens the editor in create mode inside the same modal", async () => {
      mockGet.mockImplementation(() =>
        Promise.resolve({
          data: { connections: [] },
          response: okResponse,
        }),
      );
      const user = userEvent.setup({
        pointerEventsCheck: PointerEventsCheckLevel.Never,
      });
      render(<ManageProvidersModal {...makeProps()} />);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /\+ new connection/i })).toBeTruthy(),
      );

      await user.click(screen.getByRole("button", { name: /\+ new connection/i }));

      // Create-mode title; still one dialog in the DOM.
      await waitFor(() =>
        expect(screen.getByRole("heading", { name: /new provider connection/i })).toBeTruthy(),
      );
      expect(screen.queryByRole("heading", { name: "Provider Connections" })).toBeNull();
      expect(screen.getAllByRole("dialog").length).toBe(1);
    });
  });
});
