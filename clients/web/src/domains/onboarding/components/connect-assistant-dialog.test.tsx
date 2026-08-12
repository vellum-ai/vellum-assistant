/**
 * Behavioral tests for the paste-a-bundle connect dialog: the host import op
 * receives the trimmed bundle and optional name, host failures render their
 * structured error copy verbatim, an access-only pairing interposes the expiry
 * warning before `onImported`, and a refresh-capable pairing completes
 * immediately. Self-contained mocks: run this file solo (`mock.module` leaks
 * across a shared `bun test` run).
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

// --- Mutable per-test state, reset in beforeEach ------------------------------

type ImportResult =
  | { ok: true; assistantId: string; accessOnly: boolean }
  | { ok: false; error: string };

const importPairedAssistantBundleMock = mock(
  async (_bundle: string, _name?: string): Promise<ImportResult> => ({
    ok: true,
    assistantId: "paired-new",
    accessOnly: false,
  }),
);

const onCloseMock = mock(() => {});
const onImportedMock = mock((_assistantId: string) => {});

// --- Mocks --------------------------------------------------------------------

mock.module("@/lib/local-mode", () => ({
  importPairedAssistantBundle: importPairedAssistantBundleMock,
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
  Textarea: ({
    fullWidth: _fullWidth,
    ...props
  }: ComponentProps<"textarea"> & { fullWidth?: boolean }) => (
    <textarea {...props} />
  ),
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

mock.module("@vellumai/design-library/components/notice", () => ({
  Notice: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const { ConnectAssistantDialog } = await import(
  "@/domains/onboarding/components/connect-assistant-dialog"
);

// --- Helpers ------------------------------------------------------------------

function renderDialog(
  overrides: Partial<
    ComponentProps<typeof ConnectAssistantDialog>
  > = {},
) {
  return render(
    <ConnectAssistantDialog
      open
      onClose={onCloseMock}
      onImported={onImportedMock}
      {...overrides}
    />,
  );
}

function fillBundle(value: string): void {
  fireEvent.change(screen.getByLabelText("Pairing bundle"), {
    target: { value },
  });
}

// --- Suite --------------------------------------------------------------------

describe("ConnectAssistantDialog", () => {
  beforeEach(() => {
    importPairedAssistantBundleMock.mockClear();
    importPairedAssistantBundleMock.mockImplementation(async () => ({
      ok: true,
      assistantId: "paired-new",
      accessOnly: false,
    }));
    onCloseMock.mockClear();
    onImportedMock.mockClear();
  });

  afterEach(cleanup);

  test("submits the trimmed bundle and name and completes via onImported", async () => {
    renderDialog();

    fillBundle("  eyJnYXRld2F5...  ");
    fireEvent.change(screen.getByLabelText("Name (optional)"), {
      target: { value: "  desk  " },
    });
    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() =>
      expect(importPairedAssistantBundleMock).toHaveBeenCalledWith(
        "eyJnYXRld2F5...",
        "desk",
      ),
    );
    await waitFor(() =>
      expect(onImportedMock).toHaveBeenCalledWith("paired-new"),
    );
  });

  test("a blank name is passed as undefined", async () => {
    renderDialog();

    fillBundle("eyJnYXRld2F5...");
    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() =>
      expect(importPairedAssistantBundleMock).toHaveBeenCalledWith(
        "eyJnYXRld2F5...",
        undefined,
      ),
    );
  });

  test("Connect stays disabled until a bundle is pasted", () => {
    renderDialog();

    expect(
      (screen.getByText("Connect") as HTMLButtonElement).disabled,
    ).toBe(true);

    fillBundle("eyJnYXRld2F5...");

    expect(
      (screen.getByText("Connect") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  test.each([
    "invalid pairing bundle. Paste the full base64 string printed by vellum pair.",
    "an assistant named 'desk' already exists locally. Choose a different name to avoid overwriting it.",
    "Connecting a paired assistant is not supported by this app version",
  ])("a host failure renders its error copy verbatim: %s", async (error) => {
    importPairedAssistantBundleMock.mockImplementation(async () => ({
      ok: false,
      error,
    }));
    renderDialog();

    fillBundle("eyJnYXRld2F5...");
    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() => expect(screen.getByText(error)).toBeTruthy());
    expect(onImportedMock).not.toHaveBeenCalled();
  });

  test("an access-only pairing interposes the expiry warning before onImported", async () => {
    importPairedAssistantBundleMock.mockImplementation(async () => ({
      ok: true,
      assistantId: "paired-new",
      accessOnly: true,
    }));
    renderDialog();

    fillBundle("eyJnYXRld2F5...");
    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() =>
      expect(
        screen.getByText(/access-only: its access expires and cannot renew/),
      ).toBeTruthy(),
    );
    expect(onImportedMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Continue"));

    expect(onImportedMock).toHaveBeenCalledWith("paired-new");
  });

  test("initialBundle prefills the paste field and guidanceMessage renders", () => {
    renderDialog({
      initialBundle: "eyJwcmVmaWxs...",
      guidanceMessage: "Open this page from a pairing link to prefill it.",
    });

    expect(
      (screen.getByLabelText("Pairing bundle") as HTMLTextAreaElement).value,
    ).toBe("eyJwcmVmaWxs...");
    expect(
      screen.getByText("Open this page from a pairing link to prefill it."),
    ).toBeTruthy();
  });

  test("Cancel closes without importing", () => {
    renderDialog();

    fireEvent.click(screen.getByText("Cancel"));

    expect(onCloseMock).toHaveBeenCalled();
    expect(importPairedAssistantBundleMock).not.toHaveBeenCalled();
  });
});
