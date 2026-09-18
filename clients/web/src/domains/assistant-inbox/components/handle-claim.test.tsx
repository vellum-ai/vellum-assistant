import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { avatarQueryKey } from "@/hooks/use-assistant-avatar";

import type { HandleClaimIo } from "../types";

// The design library's index re-exports every name from this module, so the
// stand-in has to carry them all or the import graph fails to link.
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { success: () => {}, error: () => {}, info: () => {} },
  Toaster: () => null,
  ToastContent: () => null,
}));

const { HandleClaim } = await import("./handle-claim");

const ASSISTANT_ID = "asst-test";

function renderClaim(props: { handle: string; claim?: HandleClaimIo }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  for (const supportsManifest of [true, false]) {
    client.setQueryData([...avatarQueryKey(ASSISTANT_ID), supportsManifest], {
      components: null,
      traits: null,
      customImageUrl: null,
    });
  }
  return render(
    <QueryClientProvider client={client}>
      <HandleClaim
        assistantId={ASSISTANT_ID}
        rootDomain="example.com"
        {...props}
      />
    </QueryClientProvider>,
  );
}

const FREE: HandleClaimIo = {
  check: async () => ({ available: true }),
  save: async () => ({ ok: true }),
};

afterEach(cleanup);

describe("HandleClaim", () => {
  test("is the example address alone when there is nothing to claim with", () => {
    renderClaim({ handle: "ada" });

    expect(screen.getByText("hi@ada.example.com")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("invites a claim on a generated handle, a change on a chosen one", () => {
    renderClaim({ handle: "bright-vole-02a64h", claim: FREE });
    expect(
      screen.getByRole("button", { name: "Claim your unique handle" }),
    ).toBeTruthy();
    cleanup();

    renderClaim({ handle: "ada", claim: FREE });
    expect(screen.getByRole("button", { name: "Change handle" })).toBeTruthy();
  });

  test("previews the draft in the pill and saves what was typed", async () => {
    const save = mock(async () => ({ ok: true }) as const);
    renderClaim({
      handle: "bright-vole-02a64h",
      claim: { ...FREE, save },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Claim your unique handle" }),
    );
    const field = screen.getByRole("textbox", { name: "Handle (public)" });
    fireEvent.change(field, { target: { value: "Ada Lovelace" } });
    expect(screen.getByText("hi@adalovelace.example.com")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Claim" }));
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(save).toHaveBeenCalledWith("adalovelace");
  });

  test("warns about a handle that cannot be claimed and holds the save", async () => {
    renderClaim({
      handle: "bright-vole-02a64h",
      claim: {
        ...FREE,
        check: async () => ({ available: false, message: "Taken." }),
      },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Claim your unique handle" }),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "taken" },
    });

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Taken."),
    );
    const action = screen.getByRole("button", { name: "Claim" });
    expect((action as HTMLButtonElement).disabled).toBe(true);
  });

  test("keeps the editor open with the save's refusal", async () => {
    renderClaim({
      handle: "bright-vole-02a64h",
      claim: {
        ...FREE,
        save: async () => ({ ok: false, message: "That handle is taken." }),
      },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Claim your unique handle" }),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "ada" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Claim" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "That handle is taken.",
      ),
    );
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  test("cancel puts the pill back on the current handle", () => {
    renderClaim({ handle: "ada", claim: FREE });

    fireEvent.click(screen.getByRole("button", { name: "Change handle" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "grace" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("hi@ada.example.com")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
