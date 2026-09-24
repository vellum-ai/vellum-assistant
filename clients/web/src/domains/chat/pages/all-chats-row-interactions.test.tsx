import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { AllChatsRow } from "./all-chats-page";
import { ConversationListProvider } from "@/domains/chat/components/conversation-list-context";

const originalMatchMedia = window.matchMedia;
beforeEach(() => {
  window.matchMedia = (query) => ({
    matches: query === "(hover: hover)",
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
});
afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
});

function setup(archivedAt?: number, originChannel = "vellum") {
  const onSelect = mock(() => {});
  const onArchive = mock(() => {});
  const onUnarchive = mock(() => {});
  const view = render(
    <ConversationListProvider value={{ onSelect, onArchive, onUnarchive }}>
      <AllChatsRow
        conversation={{
          conversationId: "conv-1",
          title: "Example chat",
          archivedAt,
          originChannel,
        }}
        now={new Date(2026, 8, 24)}
      />
    </ConversationListProvider>,
  );
  return { view, onSelect, onArchive, onUnarchive };
}

test("Done and its keyboard events do not also open the chat", () => {
  const { view, onSelect, onArchive } = setup();
  const done = view.getByRole("button", { name: "Mark as done" });
  fireEvent.keyDown(done, { key: "Enter" });
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.click(done);
  expect(onArchive).toHaveBeenCalledTimes(1);
  expect(onSelect).not.toHaveBeenCalled();
});

test("Reopen keeps the existing unarchive action and Done accessibility label", () => {
  const { view, onSelect, onUnarchive } = setup(100);
  expect(
    view.getByRole("button", { name: "Example chat, done" }),
  ).toBeDefined();
  fireEvent.click(view.getByRole("button", { name: "Reopen" }));
  expect(onUnarchive).toHaveBeenCalledTimes(1);
  expect(onSelect).not.toHaveBeenCalled();
});

test("Go to thread opens the chat once and readonly channels hide Done", () => {
  const { view, onSelect } = setup(undefined, "slack");
  expect(view.queryByRole("button", { name: "Mark as done" })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Go to thread" }));
  expect(onSelect).toHaveBeenCalledTimes(1);
});
