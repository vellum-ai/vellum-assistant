import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { MfaEnrollResponse } from "@/generated/api/types.gen";

const ENROLLMENT: MfaEnrollResponse = {
  factor_id: "auth_factor_01ABC",
  challenge_id: "auth_challenge_01DEF",
  qr_code: "data:image/png;base64,abc",
  secret: "JBSWY3DPEHPK3PXP",
  uri: "otpauth://totp/Vellum:alice@example.com?secret=JBSWY3DPEHPK3PXP",
  issuer: "Vellum",
  user: "alice@example.com",
  created_at: "2026-07-01T00:00:00.000Z",
};

let enrollCalls = 0;
let enrollError: unknown = null;
let enrollDeferred = false;
let fireEnrollSuccess: (() => void) | null = null;
let verifyCalls: { challenge_id: string; code: string }[] = [];
let verifyOutcome: { valid?: boolean; error?: unknown } = { valid: true };
let verifyPending = false;
let sdkDestroyCalls: string[] = [];

mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  userMfaFactorsListQueryKey: () => ["userMfaFactorsList"],
  useUserMfaFactorsCreateMutation: (options?: {
    onSuccess?: (data: MfaEnrollResponse) => void;
    onError?: (error: unknown) => void;
  }) => ({
    isPending: false,
    mutate: () => {
      enrollCalls += 1;
      if (enrollError) {
        options?.onError?.(enrollError);
      } else if (enrollDeferred) {
        fireEnrollSuccess = () => options?.onSuccess?.(ENROLLMENT);
      } else {
        options?.onSuccess?.(ENROLLMENT);
      }
    },
  }),
  useUserMfaFactorsVerifyCreateMutation: (options?: {
    onSuccess?: (data: { valid: boolean }) => void;
    onError?: (error: unknown) => void;
  }) => ({
    isPending: verifyPending,
    mutate: (variables: { body: { challenge_id: string; code: string } }) => {
      verifyCalls.push(variables.body);
      if (verifyOutcome.error) {
        options?.onError?.(verifyOutcome.error);
      } else {
        options?.onSuccess?.({ valid: verifyOutcome.valid ?? true });
      }
    },
  }),
}));

mock.module("@/generated/api/sdk.gen", () => ({
  userMfaFactorsDestroy: (options: { path: { id: string } }) => {
    sdkDestroyCalls.push(options.path.id);
    return Promise.resolve({ data: undefined });
  },
}));

const { EnrollTotpModal } = await import("./enroll-totp-modal");

function renderModal(onOpenChange: (open: boolean) => void = () => {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <EnrollTotpModal open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  enrollCalls = 0;
  enrollError = null;
  enrollDeferred = false;
  fireEnrollSuccess = null;
  verifyCalls = [];
  verifyOutcome = { valid: true };
  verifyPending = false;
  sdkDestroyCalls = [];
});

describe("EnrollTotpModal", () => {
  test("enrolls on open and shows the QR code and manual secret", async () => {
    renderModal();

    await waitFor(() => expect(enrollCalls).toBe(1));
    const qr = await screen.findByAltText(/QR code/i);
    expect(qr.getAttribute("src")).toBe(ENROLLMENT.qr_code);
    expect(screen.getByText(ENROLLMENT.secret)).not.toBeNull();
  });

  test("submits the challenge id with the entered code", async () => {
    const user = userEvent.setup();
    renderModal();

    const input = await screen.findByLabelText("6-digit code");
    await user.type(input, "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));

    expect(verifyCalls).toEqual([
      { challenge_id: "auth_challenge_01DEF", code: "123456" },
    ]);
  });

  test("closes and reports success when the code is valid", async () => {
    const user = userEvent.setup();
    let openState = true;
    renderModal((next) => {
      openState = next;
    });

    const input = await screen.findByLabelText("6-digit code");
    await user.type(input, "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => expect(openState).toBe(false));
    expect(sdkDestroyCalls).toHaveLength(0);
  });

  test("keeps the challenge and shows an inline error on a wrong code", async () => {
    const user = userEvent.setup();
    verifyOutcome = { valid: false };
    renderModal();

    const input = await screen.findByLabelText("6-digit code");
    await user.type(input, "000000");
    await user.click(screen.getByRole("button", { name: "Verify" }));

    expect(await screen.findByRole("alert")).not.toBeNull();
    expect(sdkDestroyCalls).toHaveLength(0);
  });

  test("restarts enrollment with a fresh factor when the challenge expired", async () => {
    const user = userEvent.setup();
    verifyOutcome = { error: { code: "challenge_expired" } };
    renderModal();

    const input = await screen.findByLabelText("6-digit code");
    await user.type(input, "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => expect(enrollCalls).toBe(2));
    expect(sdkDestroyCalls).toEqual(["auth_factor_01ABC"]);
    expect(await screen.findByRole("alert")).not.toBeNull();
  });

  test("cannot be dismissed while verification is in flight", async () => {
    const user = userEvent.setup();
    verifyPending = true;
    let openState = true;
    renderModal((next) => {
      openState = next;
    });

    await screen.findByLabelText("6-digit code");
    expect(
      (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // Overlay/Esc dismissals also route through onOpenChange; simulate one.
    await user.keyboard("{Escape}");

    expect(openState).toBe(true);
    expect(sdkDestroyCalls).toHaveLength(0);
  });

  test("discards an enrollment that resolves after the modal closed", async () => {
    enrollDeferred = true;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <EnrollTotpModal open onOpenChange={() => {}} />
      </QueryClientProvider>,
    );

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <EnrollTotpModal open={false} onOpenChange={() => {}} />
      </QueryClientProvider>,
    );
    fireEnrollSuccess?.();

    await waitFor(() => expect(sdkDestroyCalls).toEqual(["auth_factor_01ABC"]));
  });

  test("discards the unverified factor when the modal is cancelled", async () => {
    const user = userEvent.setup();
    let openState = true;
    renderModal((next) => {
      openState = next;
    });

    await screen.findByLabelText("6-digit code");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(openState).toBe(false));
    expect(sdkDestroyCalls).toEqual(["auth_factor_01ABC"]);
  });
});
