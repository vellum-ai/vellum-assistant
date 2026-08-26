/**
 * Behavioral tests for the URL-only add-remote-origin dialog: the address is
 * reduced to its public base before the store add, a pasted pairing link keeps
 * its device code for the caller while only the base is stored, invalid input
 * renders the inline error without touching the store, a store failure keeps
 * the dialog open with its copy, and a successful add completes via `onAdded`.
 * Self-contained mocks: run this file solo (`mock.module` leaks across a
 * shared `bun test` run).
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ComponentProps, ReactNode } from "react";

import type {
  AddOriginResult,
  RememberedOrigin,
} from "@/stores/remembered-origins-store";

// --- Mutable per-test state, reset in beforeEach ------------------------------

const addOriginMock = mock(
  async (input: { url: string; name?: string }): Promise<AddOriginResult> => ({
    ok: true,
    origin: { url: input.url, addedAt: "2026-01-01T00:00:00.000Z" },
  }),
);

const onCloseMock = mock(() => {});
const onAddedMock = mock(
  (_origin: RememberedOrigin, _deviceCode: string | null) => {},
);

// --- Mocks --------------------------------------------------------------------

// Only the store is stubbed: address validation is the real
// `parsePairingAddress`, so the dialog is exercised with production semantics.
mock.module("@/stores/remembered-origins-store", () => ({
  useRememberedOriginsStore: {
    getState: () => ({ addOrigin: addOriginMock }),
  },
}));

mock.module("@vellumai/design-library/components/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

mock.module("@vellumai/design-library/components/input", () => ({
  Input: ({
    fullWidth: _fullWidth,
    ...props
  }: ComponentProps<"input"> & { fullWidth?: boolean }) => <input {...props} />,
}));

mock.module("@vellumai/design-library/components/modal", () => ({
  Modal: {
    Root: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div>{children}</div> : null,
    Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Header: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
    Body: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Footer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  },
}));

const { AddRemoteOriginDialog } =
  await import("@/domains/onboarding/components/add-remote-origin-dialog");

// --- Helpers ------------------------------------------------------------------

const INVALID_COPY =
  "Enter the full https address, like https://example.com/assistant-1.";
const FAILED_COPY = "Failed to add the assistant. Please try again.";

function renderDialog(
  overrides: Partial<ComponentProps<typeof AddRemoteOriginDialog>> = {},
) {
  return render(
    <AddRemoteOriginDialog
      open
      onClose={onCloseMock}
      onAdded={onAddedMock}
      {...overrides}
    />,
  );
}

function fillAddress(value: string): void {
  fireEvent.change(screen.getByLabelText("Assistant address"), {
    target: { value },
  });
}

// --- Suite --------------------------------------------------------------------

describe("AddRemoteOriginDialog", () => {
  beforeEach(() => {
    addOriginMock.mockClear();
    addOriginMock.mockImplementation(async (input) => ({
      ok: true,
      origin: { url: input.url, addedAt: "2026-01-01T00:00:00.000Z" },
    }));
    onCloseMock.mockClear();
    onAddedMock.mockClear();
  });

  afterEach(cleanup);

  test("submits the normalized address and completes via onAdded", async () => {
    renderDialog();

    fillAddress("  HTTPS://Host.Example/assistant-1/  ");
    fireEvent.click(screen.getByText("Add"));

    await waitFor(() =>
      expect(addOriginMock).toHaveBeenCalledWith({
        url: "https://host.example/assistant-1",
      }),
    );
    await waitFor(() =>
      expect(onAddedMock).toHaveBeenCalledWith(
        expect.objectContaining({ url: "https://host.example/assistant-1" }),
        null,
      ),
    );
  });

  // The one-click artifact the docs point phones and tablets at. The code is
  // credential material: it reaches the caller for the navigation and never
  // reaches the store.
  test.each([
    "https://host.example/assistant/pair#device_code=ABCD-1234",
    "https://host.example/assistant/pair#deviceCode=ABCD-1234",
    "https://host.example/assistant/pair?device_code=ABCD-1234",
  ])(
    "a pairing link keeps its device code out of the store: %s",
    async (link) => {
      renderDialog();

      fillAddress(link);
      fireEvent.click(screen.getByText("Add"));

      await waitFor(() =>
        expect(onAddedMock).toHaveBeenCalledWith(
          expect.objectContaining({ url: "https://host.example" }),
          "ABCD-1234",
        ),
      );
      expect(addOriginMock).toHaveBeenCalledWith({
        url: "https://host.example",
      });
      const stored = JSON.stringify(addOriginMock.mock.calls);
      expect(stored).not.toContain("ABCD-1234");
    },
  );

  // The dialog tells users to paste the link their pairing page gave them,
  // so the app-route tail has to reduce to the public base; otherwise
  // switching would append /assistant to it and land on NotFound.
  test.each([
    ["https://host.example/assistant/pair", "https://host.example"],
    [
      "https://host.example/assistant/pair#device_code=ABCD-1234",
      "https://host.example",
    ],
    ["https://host.example/assistant", "https://host.example"],
    [
      "https://host.example/assistant-1/assistant/pair",
      "https://host.example/assistant-1",
    ],
    ["https://host.example/assistant-1", "https://host.example/assistant-1"],
    // Only the full app route reduces: a prefix that merely ends in /pair
    // is somebody's deployment path, not our pairing page.
    ["https://host.example/tenant/pair", "https://host.example/tenant/pair"],
  ])("reduces %s to the public base", async (typed, expected) => {
    renderDialog();

    fillAddress(typed);
    fireEvent.click(screen.getByText("Add"));

    await waitFor(() =>
      expect(addOriginMock).toHaveBeenCalledWith({ url: expected }),
    );
  });

  test.each([
    "http://host.example/assistant-1",
    "javascript:alert(1)",
    "not a url",
  ])(
    "invalid input renders the inline error without a store add: %s",
    async (value) => {
      renderDialog();

      fillAddress(value);
      fireEvent.click(screen.getByText("Add"));

      await waitFor(() => expect(screen.getByText(INVALID_COPY)).toBeTruthy());
      expect(addOriginMock).not.toHaveBeenCalled();
      expect(onAddedMock).not.toHaveBeenCalled();
    },
  );

  test("a store failure keeps the dialog open with the failure copy", async () => {
    addOriginMock.mockImplementation(async () => ({ ok: false }));
    renderDialog();

    fillAddress("https://host.example/assistant-1");
    fireEvent.click(screen.getByText("Add"));

    await waitFor(() => expect(screen.getByText(FAILED_COPY)).toBeTruthy());
    expect(onAddedMock).not.toHaveBeenCalled();
    // The form is still up for a retry.
    expect(screen.getByLabelText("Assistant address")).toBeTruthy();
  });

  test("Add stays disabled until an address is typed", () => {
    renderDialog();

    expect((screen.getByText("Add") as HTMLButtonElement).disabled).toBe(true);

    fillAddress("https://host.example");

    expect((screen.getByText("Add") as HTMLButtonElement).disabled).toBe(false);
  });

  test("Cancel closes without adding", () => {
    renderDialog();

    fireEvent.click(screen.getByText("Cancel"));

    expect(onCloseMock).toHaveBeenCalled();
    expect(addOriginMock).not.toHaveBeenCalled();
  });
});
