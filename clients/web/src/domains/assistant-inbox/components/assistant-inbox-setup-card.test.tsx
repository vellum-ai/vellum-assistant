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

import {
  AssistantInboxSetupCard,
  type AssistantInboxSetupCardProps,
} from "./assistant-inbox-setup-card";

const ASSISTANT_ID = "asst-test";

function renderCard(props: Partial<AssistantInboxSetupCardProps>) {
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
      <AssistantInboxSetupCard
        assistantId={ASSISTANT_ID}
        handle="bright-vole"
        rootDomain="example.com"
        onConfirm={() => {}}
        {...props}
      />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("AssistantInboxSetupCard", () => {
  test("keeps a settled handle as text, with the prefix as the one field", () => {
    const onConfirm = mock(() => {});
    renderCard({ onConfirm });

    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(
      screen.queryByRole("textbox", { name: "Handle (public)" }),
    ).toBeNull();
    expect(screen.queryByText(/won't be able to change it/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    expect(onConfirm).toHaveBeenCalledWith({
      prefix: "hi",
      handle: "bright-vole",
    });
  });

  test("lets an open handle be chosen, and confirms with what was typed", () => {
    const onConfirm = mock(() => {});
    renderCard({ handleEditable: true, onConfirm });

    const field = screen.getByRole("textbox", { name: "Handle (public)" });
    expect((field as HTMLInputElement).value).toBe("bright-vole");
    expect(screen.getByText(/won't be able to change it/)).toBeTruthy();

    // Held to what a subdomain allows, as it is typed.
    fireEvent.change(field, { target: { value: "My Assistant_01!" } });
    expect((field as HTMLInputElement).value).toBe("myassistant01");
    expect(screen.getByText("hi@myassistant01.example.com")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    expect(onConfirm).toHaveBeenCalledWith({
      prefix: "hi",
      handle: "myassistant01",
    });
  });

  test("warns about a handle that cannot be claimed and holds the action", async () => {
    const checkHandle = mock(async (handle: string) =>
      handle === "taken"
        ? ({ available: false, message: "That handle is taken." } as const)
        : ({ available: true } as const),
    );
    renderCard({ handleEditable: true, checkHandle });

    const field = screen.getByRole("textbox", { name: "Handle (public)" });
    fireEvent.change(field, { target: { value: "taken" } });

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "That handle is taken.",
      ),
    );
    const action = screen.getByRole("button", { name: "Get started" });
    expect((action as HTMLButtonElement).disabled).toBe(true);

    // A new draft clears the warning at once, before its own probe lands.
    fireEvent.change(field, { target: { value: "free" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect((action as HTMLButtonElement).disabled).toBe(false);
  });

  test("does not probe the handle the assistant already holds", async () => {
    const checkHandle = mock(async () => ({ available: true }) as const);
    renderCard({ handleEditable: true, checkHandle });

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(checkHandle).not.toHaveBeenCalled();
  });

  test("shows the registration's refusal under the fields", () => {
    renderCard({
      handleEditable: true,
      error: "Subdomain already registered.",
    });

    expect(screen.getByRole("alert").textContent).toBe(
      "Subdomain already registered.",
    );
    // The refusal is about the last draft; the next one may go through.
    const action = screen.getByRole("button", { name: "Get started" });
    expect((action as HTMLButtonElement).disabled).toBe(false);
  });
});
