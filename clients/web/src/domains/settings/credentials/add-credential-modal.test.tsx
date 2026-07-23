/**
 * Tests for `AddCredentialModal`:
 *
 *   1. The entered service / field / secret value / label reach the
 *      credentials-set mutation — service and field trimmed, the secret
 *      value verbatim — and a successful save fires `onSaved` + `onClose`.
 *   2. An empty label is omitted from the payload rather than sent as "".
 *   3. `initialValues` pre-populates every input (the prefill surface a
 *      chat-domain consumer uses).
 *   4. Cancel closes without saving.
 *
 * All credential values are synthetic fixtures.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  type UseMutationOptions,
} from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import type { AddCredentialModalProps } from "@/domains/settings/credentials/add-credential-modal";

const ASSISTANT_ID = "asst-test";
mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => ASSISTANT_ID,
}));

const toasts: Array<{ kind: "success" | "error"; message: string }> = [];
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: {
    success: (message: string) => {
      toasts.push({ kind: "success", message });
    },
    error: (message: string) => {
      toasts.push({ kind: "error", message });
    },
  },
  Toaster: () => null,
  ToastContent: () => null,
}));

interface SetCall {
  path: { assistant_id: string };
  body: {
    service: string;
    field: string;
    value: string;
    label?: string;
  };
}
const setCalls: SetCall[] = [];
// The real generated hook wraps TanStack's `useMutation`; the mock keeps that
// wiring (isPending, hook-level and per-call callbacks) and only swaps the
// network layer for a recorder.
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  useCredentialsSetPostMutation: (
    options: UseMutationOptions<unknown, Error, SetCall> = {},
  ) =>
    useMutation<unknown, Error, SetCall>({
      mutationFn: (variables) => {
        setCalls.push(variables);
        return Promise.resolve({});
      },
      ...options,
    }),
}));

const { AddCredentialModal } =
  await import("@/domains/settings/credentials/add-credential-modal");

function renderModal(props: Partial<AddCredentialModalProps> = {}) {
  const queryClient = new QueryClient();
  const onClose = mock<AddCredentialModalProps["onClose"]>(() => {});
  const onSaved = mock<AddCredentialModalProps["onSaved"]>(() => {});
  render(
    <QueryClientProvider client={queryClient}>
      <AddCredentialModal open onClose={onClose} onSaved={onSaved} {...props} />
    </QueryClientProvider>,
  );
  return { onClose, onSaved };
}

function input(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

function submitForm(): void {
  const form = screen
    .getByRole("button", { name: "Save" })
    .closest("form") as HTMLFormElement;
  fireEvent.submit(form);
}

describe("AddCredentialModal", () => {
  beforeEach(() => {
    setCalls.length = 0;
    toasts.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  test("saves the entered fields — service/field trimmed, value verbatim — then fires onSaved and onClose", async () => {
    const { onClose, onSaved } = renderModal();

    fireEvent.change(input("Service"), { target: { value: "  github  " } });
    fireEvent.change(input("Field"), { target: { value: "api_token " } });
    fireEvent.change(input("Value"), {
      target: { value: " synthetic-secret-value " },
    });
    fireEvent.change(input("Label (optional)"), {
      target: { value: "Synthetic test token" },
    });
    submitForm();

    await waitFor(() => expect(setCalls.length).toBe(1));
    expect(setCalls[0]).toEqual({
      path: { assistant_id: ASSISTANT_ID },
      body: {
        service: "github",
        field: "api_token",
        value: " synthetic-secret-value ",
        label: "Synthetic test token",
      },
    });

    await waitFor(() => expect(onSaved.mock.calls.length).toBe(1));
    expect(onSaved.mock.calls[0]).toEqual([
      { service: "github", field: "api_token", label: "Synthetic test token" },
    ]);
    expect(onClose.mock.calls.length).toBe(1);
    expect(toasts).toEqual([{ kind: "success", message: "Credential saved." }]);
  });

  test("omits an empty label from the payload and the onSaved meta", async () => {
    const { onSaved } = renderModal();

    fireEvent.change(input("Service"), { target: { value: "openai" } });
    fireEvent.change(input("Field"), { target: { value: "api_key" } });
    fireEvent.change(input("Value"), {
      target: { value: "synthetic-key-123" },
    });
    submitForm();

    await waitFor(() => expect(setCalls.length).toBe(1));
    expect(setCalls[0]!.body.label).toBeUndefined();
    await waitFor(() => expect(onSaved.mock.calls.length).toBe(1));
    expect(onSaved.mock.calls[0]).toEqual([
      { service: "openai", field: "api_key", label: undefined },
    ]);
  });

  test("does not submit while a required field is empty", () => {
    renderModal();

    fireEvent.change(input("Service"), { target: { value: "github" } });
    // Field and Value left empty.
    submitForm();

    expect(setCalls.length).toBe(0);
    const saveButton = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
  });

  test("initialValues prefill every input", () => {
    renderModal({
      initialValues: {
        service: "stripe",
        field: "secret_key",
        value: "synthetic-prefilled-value",
        label: "Synthetic Stripe key",
      },
    });

    expect(input("Service").value).toBe("stripe");
    expect(input("Field").value).toBe("secret_key");
    expect(input("Value").value).toBe("synthetic-prefilled-value");
    expect(input("Label (optional)").value).toBe("Synthetic Stripe key");
  });

  test("Cancel closes without saving", () => {
    const { onClose, onSaved } = renderModal();

    fireEvent.change(input("Value"), {
      target: { value: "synthetic-discarded" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose.mock.calls.length).toBe(1);
    expect(onSaved.mock.calls.length).toBe(0);
    expect(setCalls.length).toBe(0);
  });
});
