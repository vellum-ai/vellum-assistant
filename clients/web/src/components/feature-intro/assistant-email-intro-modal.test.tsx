import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

import { avatarQueryKey } from "@/hooks/use-assistant-avatar";

import {
  AssistantEmailIntroModal,
  type AssistantEmailIntroModalProps,
} from "./assistant-email-intro-modal";

const ASSISTANT_ID = "asst-test";

function renderModal(overrides: Partial<AssistantEmailIntroModalProps> = {}) {
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
  const props: AssistantEmailIntroModalProps = {
    open: true,
    onOpenChange: () => {},
    assistantId: ASSISTANT_ID,
    assistantName: "Mel",
    rootDomain: "vellum.me",
    locked: true,
    onUpgrade: () => {},
    onSeePlans: () => {},
    onSetUp: () => {},
    ...overrides,
  };
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AssistantEmailIntroModal {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("AssistantEmailIntroModal", () => {
  test("a plan without email gets the pitch, the perks and the upgrade", () => {
    const pressed: string[] = [];
    renderModal({
      onUpgrade: () => pressed.push("upgrade"),
      onSeePlans: () => pressed.push("plans"),
    });
    expect(screen.getByText("Give Mel an inbox")).toBeTruthy();
    expect(screen.getByText("A real address on vellum.me")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Super" }));
    fireEvent.click(screen.getByRole("button", { name: "Plans" }));
    expect(pressed).toEqual(["upgrade", "plans"]);
    expect(screen.queryByRole("button", { name: "Set up email" })).toBeNull();
  });

  test("a plan with email gets the perks and the way into setup", () => {
    let setUp = 0;
    renderModal({ locked: false, onSetUp: () => setUp++ });
    expect(
      screen.getByText("Every message kept here, inbox and sent"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Upgrade to Super" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set up email" }));
    expect(setUp).toBe(1);
  });

  test("the close glyph reports the dismissal", () => {
    const changes: boolean[] = [];
    renderModal({ onOpenChange: (open) => changes.push(open) });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(changes).toEqual([false]);
  });
});
