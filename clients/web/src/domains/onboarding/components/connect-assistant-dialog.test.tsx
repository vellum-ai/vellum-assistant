/**
 * Behavioral tests for the one-field connect dialog: a pairing link imports on
 * the first poll with no intermediate state, a bare address shows its approval
 * code and polls until the host approves, a refused address renders the
 * dialog's own catalog copy while every other host failure renders the host's
 * verbatim, the countdown follows the deadline each poll reports, an
 * unreachable host is polled through without losing the approval code, an
 * access-only pairing interposes the expiry warning before `onImported`, and
 * cancelling drops the host-side session.
 * Self-contained mocks: run this file solo (`mock.module` leaks across a shared
 * `bun test` run).
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  isRetryablePairingReason,
  type PairingFailureReason,
  type PublicBaseUrlRejection,
} from "@vellumai/service-contracts/remote-web-pairing";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ComponentProps, ReactNode } from "react";

// --- Mutable per-test state, reset in beforeEach ------------------------------

type StartResult =
  | {
      ok: true;
      handle: string;
      userCode: string | null;
      expiresAt: string;
      intervalSeconds: number;
    }
  | { ok: false; error: string; rejection?: PublicBaseUrlRejection };

type PollResult =
  | { ok: true; status: "pending"; expiresAt: string; intervalSeconds: number }
  | { ok: true; status: "imported"; assistantId: string; accessOnly: boolean }
  | { ok: false; error: string; reason?: PairingFailureReason };

const startedFromLink: StartResult = {
  ok: true,
  handle: "handle-1",
  userCode: null,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  // Zero keeps a polling test from waiting on a real timer: the loop yields to
  // the microtask queue and comes straight back.
  intervalSeconds: 0,
};

const startAssistantPairingMock = mock(
  async (_address: string): Promise<StartResult> => startedFromLink,
);

const pollAssistantPairingMock = mock(
  async (_handle: string, _name?: string): Promise<PollResult> => ({
    ok: true,
    status: "imported",
    assistantId: "paired-new",
    accessOnly: false,
  }),
);

const cancelAssistantPairingMock = mock(async (_handle: string) => {});

const onCloseMock = mock(() => {});
const onImportedMock = mock((_assistantId: string) => {});

// --- Mocks --------------------------------------------------------------------

// This file replaces the whole module rather than pulling its transport
// dependencies in, so the classifier is rebuilt from the shared reason table
// the real one reads.
mock.module("@/lib/local-mode", () => ({
  startAssistantPairing: startAssistantPairingMock,
  pollAssistantPairing: pollAssistantPairingMock,
  cancelAssistantPairing: cancelAssistantPairingMock,
  isRetryablePairingFailure: (failure: { reason?: PairingFailureReason }) =>
    isRetryablePairingReason(failure.reason),
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

mock.module("@vellumai/design-library/components/notice", () => ({
  Notice: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const { ConnectAssistantDialog } =
  await import("@/domains/onboarding/components/connect-assistant-dialog");

// --- Helpers ------------------------------------------------------------------

function renderDialog(
  overrides: Partial<ComponentProps<typeof ConnectAssistantDialog>> = {},
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

function fillAddress(value: string): void {
  fireEvent.change(screen.getByLabelText("Address or pairing link"), {
    target: { value },
  });
}

// --- Suite --------------------------------------------------------------------

describe("ConnectAssistantDialog", () => {
  beforeEach(() => {
    startAssistantPairingMock.mockClear();
    startAssistantPairingMock.mockImplementation(async () => startedFromLink);
    pollAssistantPairingMock.mockClear();
    pollAssistantPairingMock.mockImplementation(async () => ({
      ok: true,
      status: "imported",
      assistantId: "paired-new",
      accessOnly: false,
    }));
    cancelAssistantPairingMock.mockClear();
    onCloseMock.mockClear();
    onImportedMock.mockClear();
  });

  afterEach(cleanup);

  test("a pairing link imports on the first poll with no approval step", async () => {
    renderDialog();

    fillAddress("  https://gw.example.com/assistant/pair#device_code=abc  ");
    fireEvent.change(screen.getByLabelText("Name (optional)"), {
      target: { value: "  desk  " },
    });
    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() =>
      expect(startAssistantPairingMock).toHaveBeenCalledWith(
        "https://gw.example.com/assistant/pair#device_code=abc",
      ),
    );
    await waitFor(() =>
      expect(onImportedMock).toHaveBeenCalledWith("paired-new"),
    );
    expect(pollAssistantPairingMock).toHaveBeenCalledWith("handle-1", "desk");
    expect(screen.queryByText(/Waiting for approval/)).toBeNull();
  });

  test("a blank name is passed as undefined", async () => {
    renderDialog();

    fillAddress("https://gw.example.com");
    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() =>
      expect(pollAssistantPairingMock).toHaveBeenCalledWith(
        "handle-1",
        undefined,
      ),
    );
  });

  test("a bare address shows its approval code and polls until approved", async () => {
    startAssistantPairingMock.mockImplementation(async () => ({
      ...startedFromLink,
      userCode: "ABCD-EFGH",
    }));
    let polls = 0;
    pollAssistantPairingMock.mockImplementation(async () => {
      polls += 1;
      if (polls === 1) {
        return {
          ok: true,
          status: "pending",
          expiresAt: startedFromLink.expiresAt,
          intervalSeconds: 0,
        };
      }
      return {
        ok: true,
        status: "imported",
        assistantId: "paired-new",
        accessOnly: false,
      };
    });
    renderDialog();

    fillAddress("https://gw.example.com");
    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() => expect(screen.getByText("ABCD-EFGH")).toBeTruthy());
    expect(
      screen.getByText(
        "Approve this code on the assistant's machine to finish connecting.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Waiting for approval…")).toBeTruthy();
    expect(screen.getByText(/Expires in \d+:\d\d/)).toBeTruthy();

    await waitFor(() =>
      expect(onImportedMock).toHaveBeenCalledWith("paired-new"),
    );
  });

  test("the countdown follows the deadline each pending poll reports", async () => {
    startAssistantPairingMock.mockImplementation(async () => ({
      ...startedFromLink,
      userCode: "ABCD-EFGH",
      // Nearly spent: the rendered countdown starts at 0:04.
      expiresAt: new Date(Date.now() + 4_000).toISOString(),
    }));
    let polls = 0;
    pollAssistantPairingMock.mockImplementation(async () => {
      polls += 1;
      if (polls === 1) {
        // The gateway extended the attempt; the dialog has to follow it or
        // the countdown reads 0:00 while the loop is still polling.
        return {
          ok: true,
          status: "pending",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          intervalSeconds: 0,
        };
      }
      return new Promise<PollResult>(() => {});
    });
    renderDialog();

    fillAddress("https://gw.example.com");
    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() =>
      expect(screen.getByText(/Expires in (?:10:00|9:5\d)/)).toBeTruthy(),
    );
    expect(screen.queryByText(/Expires in 0:0\d/)).toBeNull();
  });

  test("Connect stays disabled until an address is entered", () => {
    renderDialog();

    expect((screen.getByText("Connect") as HTMLButtonElement).disabled).toBe(
      true,
    );

    fillAddress("https://gw.example.com");

    expect((screen.getByText("Connect") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  test.each([
    "That address points back at this machine. Use the assistant's public https address.",
    "an assistant named 'desk' already exists locally. Choose a different name to avoid overwriting it.",
    "Connecting a paired assistant is not supported by this app version",
  ])("a host failure renders its error copy verbatim: %s", async (error) => {
    startAssistantPairingMock.mockImplementation(async () => ({
      ok: false,
      error,
    }));
    renderDialog();

    fillAddress("https://gw.example.com");
    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() => expect(screen.getByText(error)).toBeTruthy());
    expect(onImportedMock).not.toHaveBeenCalled();
  });

  test.each([
    [
      "loopback" as const,
      "https://localhost:7830",
      "This is a loopback address other devices can't reach. Enter the assistant's public https URL.",
    ],
    [
      "non-https" as const,
      "http://gw.example.com",
      "The URL must use https so your devices can connect securely.",
    ],
    [
      "service-website" as const,
      "https://login.tailscale.com/admin",
      "This is Tailscale's website, not your assistant's address. Start a tunnel on the host to get one; `vellum tunnel --help` lists the providers.",
    ],
  ])(
    "a refused address renders the catalog copy, not the host's English: %s",
    async (rejection, address, copy) => {
      const hostEnglish = "Host copy that must not reach the user.";
      startAssistantPairingMock.mockImplementation(async () => ({
        ok: false,
        error: hostEnglish,
        rejection,
      }));
      renderDialog();

      fillAddress(address);
      fireEvent.click(screen.getByText("Connect"));

      await waitFor(() => expect(screen.getByText(copy)).toBeTruthy());
      expect(screen.queryByText(hostEnglish)).toBeNull();
    },
  );

  test("an expired code returns to the form with the host's error", async () => {
    startAssistantPairingMock.mockImplementation(async () => ({
      ...startedFromLink,
      userCode: "ABCD-EFGH",
    }));
    pollAssistantPairingMock.mockImplementation(async () => ({
      ok: false,
      error:
        "The pairing code expired or was denied. Start over to get a new one.",
    }));
    renderDialog();

    fillAddress("https://gw.example.com");
    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() =>
      expect(
        screen.getByText(/The pairing code expired or was denied/),
      ).toBeTruthy(),
    );
    expect(screen.queryByText("ABCD-EFGH")).toBeNull();
    expect(screen.getByLabelText("Address or pairing link")).toBeTruthy();
    expect(onImportedMock).not.toHaveBeenCalled();
  });

  test("a transient unreachable poll retries without losing the approval code", async () => {
    startAssistantPairingMock.mockImplementation(async () => ({
      ...startedFromLink,
      userCode: "ABCD-EFGH",
    }));
    let resolveRetry: (result: PollResult) => void = () => {};
    let polls = 0;
    pollAssistantPairingMock.mockImplementation(() => {
      polls += 1;
      if (polls === 1) {
        return Promise.resolve<PollResult>({
          ok: false,
          reason: "unreachable",
          error:
            "Could not reach that assistant. Check the address and that it is online.",
        });
      }
      // Parked so the retry state stays on screen long enough to assert.
      return new Promise<PollResult>((resolve) => {
        resolveRetry = resolve;
      });
    });
    renderDialog();

    fillAddress("https://gw.example.com");
    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() =>
      expect(
        screen.getByText(
          "The assistant isn't ready to pair yet. Still trying until the code expires.",
        ),
      ).toBeTruthy(),
    );
    // The host-side session and the code it minted both survive the blip.
    expect(cancelAssistantPairingMock).not.toHaveBeenCalled();
    expect(screen.getByText("ABCD-EFGH")).toBeTruthy();
    expect(screen.getByText(/Expires in \d+:\d\d/)).toBeTruthy();
    expect(screen.queryByLabelText("Address or pairing link")).toBeNull();

    await act(async () => {
      resolveRetry({
        ok: true,
        status: "imported",
        assistantId: "paired-new",
        accessOnly: false,
      });
    });

    await waitFor(() =>
      expect(onImportedMock).toHaveBeenCalledWith("paired-new"),
    );
    expect(cancelAssistantPairingMock).not.toHaveBeenCalled();
  });

  test("a repairable gateway refusal retries without losing the approval code", async () => {
    startAssistantPairingMock.mockImplementation(async () => ({
      ...startedFromLink,
      userCode: "ABCD-EFGH",
    }));
    let polls = 0;
    pollAssistantPairingMock.mockImplementation(async () => {
      polls += 1;
      if (polls === 1) {
        return {
          ok: false,
          reason: "gateway-retryable",
          error: "The assistant could not finish the pairing (HTTP 503).",
        };
      }
      return {
        ok: true,
        status: "imported",
        assistantId: "paired-new",
        accessOnly: false,
      };
    });
    renderDialog();

    fillAddress("https://gw.example.com");
    fireEvent.click(screen.getByText("Connect"));

    // The gateway released the code, so the approved session finishes on the
    // next attempt rather than sending the user back to mint another code.
    await waitFor(() =>
      expect(onImportedMock).toHaveBeenCalledWith("paired-new"),
    );
    expect(cancelAssistantPairingMock).not.toHaveBeenCalled();
    expect(pollAssistantPairingMock).toHaveBeenCalledTimes(2);
  });

  test("a settled failure ends the session and returns to the form", async () => {
    startAssistantPairingMock.mockImplementation(async () => ({
      ...startedFromLink,
      userCode: "ABCD-EFGH",
    }));
    pollAssistantPairingMock.mockImplementation(async () => ({
      ok: false,
      reason: "gateway",
      error:
        "The assistant approved the pairing but returned credentials this device cannot use.",
    }));
    renderDialog();

    fillAddress("https://gw.example.com");
    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() =>
      expect(
        screen.getByText(
          "The assistant approved the pairing but returned credentials this device cannot use.",
        ),
      ).toBeTruthy(),
    );
    expect(pollAssistantPairingMock).toHaveBeenCalledTimes(1);
    expect(cancelAssistantPairingMock).toHaveBeenCalledWith("handle-1");
    expect(screen.queryByText("ABCD-EFGH")).toBeNull();
    expect(onImportedMock).not.toHaveBeenCalled();
  });

  test("retrying stops once the pairing code has expired", async () => {
    startAssistantPairingMock.mockImplementation(async () => ({
      ...startedFromLink,
      userCode: "ABCD-EFGH",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    }));
    pollAssistantPairingMock.mockImplementation(async () => ({
      ok: false,
      reason: "unreachable",
      error:
        "Could not reach that assistant. Check the address and that it is online.",
    }));
    renderDialog();

    fillAddress("https://gw.example.com");
    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() =>
      expect(
        screen.getByText(
          "The pairing code expired before the assistant was ready to pair. Start over to get a new one.",
        ),
      ).toBeTruthy(),
    );
    expect(pollAssistantPairingMock).toHaveBeenCalledTimes(1);
    expect(cancelAssistantPairingMock).toHaveBeenCalledWith("handle-1");
    expect(screen.getByLabelText("Address or pairing link")).toBeTruthy();
    expect(onImportedMock).not.toHaveBeenCalled();
  });

  test("an unreachable host ends a pairing-link attempt at once", async () => {
    pollAssistantPairingMock.mockImplementation(async () => ({
      ok: false,
      reason: "unreachable",
      error:
        "Could not reach that assistant. Check the address and that it is online.",
    }));
    renderDialog();

    fillAddress("https://gw.example.com/assistant/pair#device_code=abc");
    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() =>
      expect(screen.getByText(/Could not reach that assistant/)).toBeTruthy(),
    );
    expect(pollAssistantPairingMock).toHaveBeenCalledTimes(1);
    expect(cancelAssistantPairingMock).toHaveBeenCalledWith("handle-1");
  });

  test("an access-only pairing interposes the expiry warning before onImported", async () => {
    pollAssistantPairingMock.mockImplementation(async () => ({
      ok: true,
      status: "imported",
      assistantId: "paired-new",
      accessOnly: true,
    }));
    renderDialog();

    fillAddress("https://gw.example.com");
    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() =>
      expect(
        screen.getByText(
          /access-only: it works now, but its access expires and cannot renew itself\. When it does, generate a fresh pairing link/,
        ),
      ).toBeTruthy(),
    );
    expect(onImportedMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Continue"));

    expect(onImportedMock).toHaveBeenCalledWith("paired-new");
  });

  test("initialAddress prefills the field and guidanceKind renders its copy", () => {
    renderDialog({
      initialAddress: "https://gw.example.com",
      guidanceKind: "legacy",
    });

    expect(
      (screen.getByLabelText("Address or pairing link") as HTMLInputElement)
        .value,
    ).toBe("https://gw.example.com");
    expect(
      screen.getByText(
        "This link came from an older version of the app and can no longer be used. Generate a new pairing link on the assistant's machine and paste it here.",
      ),
    ).toBeTruthy();
  });

  test("the generic guidance kind renders the QR-link copy", () => {
    renderDialog({ guidanceKind: "generic" });

    expect(
      screen.getByText(
        "This link came from a pairing QR code. To connect this device, paste the pairing link from the assistant's machine here.",
      ),
    ).toBeTruthy();
  });

  test("Cancel closes without starting a pairing", () => {
    renderDialog();

    fireEvent.click(screen.getByText("Cancel"));

    expect(onCloseMock).toHaveBeenCalled();
    expect(startAssistantPairingMock).not.toHaveBeenCalled();
  });

  test("closing mid-approval drops the host-side session", async () => {
    startAssistantPairingMock.mockImplementation(async () => ({
      ...startedFromLink,
      userCode: "ABCD-EFGH",
    }));
    pollAssistantPairingMock.mockImplementation(async () => ({
      ok: true,
      status: "pending",
      expiresAt: startedFromLink.expiresAt,
      intervalSeconds: 60,
    }));
    const { rerender } = renderDialog();

    fillAddress("https://gw.example.com");
    fireEvent.click(screen.getByText("Connect"));
    await waitFor(() => expect(screen.getByText("ABCD-EFGH")).toBeTruthy());

    rerender(
      <ConnectAssistantDialog
        open={false}
        onClose={onCloseMock}
        onImported={onImportedMock}
      />,
    );

    await waitFor(() =>
      expect(cancelAssistantPairingMock).toHaveBeenCalledWith("handle-1"),
    );
  });

  test("closing before the host answers drops the session it hands back", async () => {
    let answer: (result: StartResult) => void = () => {};
    startAssistantPairingMock.mockImplementation(
      () =>
        new Promise<StartResult>((resolve) => {
          answer = resolve;
        }),
    );
    const { rerender } = renderDialog();

    fillAddress("https://gw.example.com");
    fireEvent.click(screen.getByText("Connect"));
    await waitFor(() => expect(startAssistantPairingMock).toHaveBeenCalled());

    rerender(
      <ConnectAssistantDialog
        open={false}
        onClose={onCloseMock}
        onImported={onImportedMock}
      />,
    );
    // Nothing to cancel yet: the handle only exists once the host answers.
    expect(cancelAssistantPairingMock).not.toHaveBeenCalled();

    answer({ ...startedFromLink, handle: "handle-late" });

    await waitFor(() =>
      expect(cancelAssistantPairingMock).toHaveBeenCalledWith("handle-late"),
    );
    expect(cancelAssistantPairingMock).toHaveBeenCalledTimes(1);
    expect(pollAssistantPairingMock).not.toHaveBeenCalled();
    expect(onImportedMock).not.toHaveBeenCalled();
  });

  test("reopening does not resume the attempt abandoned by the close", async () => {
    let answer: (result: StartResult) => void = () => {};
    startAssistantPairingMock.mockImplementation(
      () =>
        new Promise<StartResult>((resolve) => {
          answer = resolve;
        }),
    );
    const { rerender } = renderDialog();

    fillAddress("https://gw.example.com");
    fireEvent.click(screen.getByText("Connect"));
    await waitFor(() => expect(startAssistantPairingMock).toHaveBeenCalled());

    rerender(
      <ConnectAssistantDialog
        open={false}
        onClose={onCloseMock}
        onImported={onImportedMock}
      />,
    );
    rerender(
      <ConnectAssistantDialog
        open
        onClose={onCloseMock}
        onImported={onImportedMock}
      />,
    );

    answer({ ...startedFromLink, handle: "handle-late" });

    await waitFor(() =>
      expect(cancelAssistantPairingMock).toHaveBeenCalledWith("handle-late"),
    );
    expect(pollAssistantPairingMock).not.toHaveBeenCalled();
    expect(onImportedMock).not.toHaveBeenCalled();
  });
});
