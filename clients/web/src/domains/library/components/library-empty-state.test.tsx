/**
 * Tests for LibraryEmptyState.
 *
 * The empty state is a single entry point: start a conversation. Importing a
 * `.vellum` bundle is offered by the library header instead, so the component
 * must not carry an import button or a file picker of its own.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render, screen } from "@testing-library/react";

import { LibraryEmptyState } from "./library-empty-state";

afterEach(() => {
  cleanup();
});

describe("LibraryEmptyState", () => {
  test("offers the new-conversation entry point", () => {
    render(<LibraryEmptyState onNewConversation={() => {}} />);

    expect(screen.getByText("Your library is empty")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "New Conversation" }),
    ).not.toBeNull();
  });

  test("renders no import button and no file input", () => {
    const { container } = render(
      <LibraryEmptyState onNewConversation={() => {}} />,
    );

    expect(screen.queryByText(/import/i)).toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });

  test("omits the button when no conversation callback is given", () => {
    render(<LibraryEmptyState />);

    expect(screen.queryByRole("button")).toBeNull();
  });
});
