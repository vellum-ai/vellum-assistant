import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DocumentChatNavigation } from "./document-chat-navigation";

afterEach(cleanup);

test("reopens the retained document without a persistent status message", async () => {
  const onReopenDocument = mock(() => {});
  render(<DocumentChatNavigation onReopenDocument={onReopenDocument} />);
  await userEvent.setup().click(
    screen.getByRole("button", { name: "Reopen document" }),
  );
  expect(onReopenDocument).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByText("Replies appear in the conversation")).toBeNull();
});
