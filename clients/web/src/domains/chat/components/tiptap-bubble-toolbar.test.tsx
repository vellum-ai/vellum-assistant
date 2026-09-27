/**
 * The selection toolbar against a headless editor: link editing in place of
 * `window.prompt`, and the block and mark commands its buttons run. The
 * floating placement is Tiptap's; what is covered here is what each control
 * does to the document.
 */

import { afterEach, expect, mock, test } from "bun:test";
import { Editor } from "@tiptap/core";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BubbleToolbar } from "./tiptap-bubble-toolbar";
import {
  buildDocumentEditorExtensions,
  getEditorMarkdown,
} from "./tiptap-editor-extensions";

let editor: Editor | null = null;

function setup(content: string, from: number, to: number) {
  editor = new Editor({ extensions: buildDocumentEditorExtensions(), content });
  editor.commands.setTextSelection({ from, to });
  const ed = editor;
  const onCommentSubmit = mock((_comment: string) => {});
  render(<BubbleToolbar editor={ed} onCommentSubmit={onCommentSubmit} />);
  return { ed, onCommentSubmit, user: userEvent.setup() };
}

afterEach(() => {
  cleanup();
  editor?.destroy();
  editor = null;
  document.body.style.pointerEvents = "";
});

test("Enter in the link field links the selection with a normalized href", async () => {
  const { ed, user } = setup("read this", 1, 5);
  await user.click(screen.getByRole("button", { name: "Link" }));
  const field = screen.getByLabelText("Link address");
  expect(document.activeElement).toBe(field);
  await user.type(field, "example.com/guide{Enter}");
  expect(getEditorMarkdown(ed)).toBe("[read](https://example.com/guide) this");
  expect(screen.queryByLabelText("Link address")).toBeNull();
});

test("an address that is not a web or mail link is refused", async () => {
  const { ed, user } = setup("read this", 1, 5);
  await user.click(screen.getByRole("button", { name: "Link" }));
  await user.type(
    screen.getByLabelText("Link address"),
    "javascript:alert(1){Enter}",
  );
  expect(screen.getByText("Use a web or email address")).toBeTruthy();
  expect(getEditorMarkdown(ed)).toBe("read this");
});

test("Escape closes the link field without changing the document", async () => {
  const { ed, user } = setup("read this", 1, 5);
  await user.click(screen.getByRole("button", { name: "Link" }));
  await user.type(screen.getByLabelText("Link address"), "example.com");
  const escape = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    screen.getByLabelText("Link address").dispatchEvent(escape);
  });
  expect(escape.defaultPrevented).toBe(true);
  expect(screen.queryByLabelText("Link address")).toBeNull();
  expect(screen.getByRole("toolbar")).toBeTruthy();
  expect(getEditorMarkdown(ed)).toBe("read this");
});

test("an existing link opens prefilled and can be edited or removed", async () => {
  const { ed, user } = setup("[read](https://old.example.com) this", 2, 4);
  const linkButton = screen.getByRole("button", { name: "Link" });
  expect(linkButton.getAttribute("aria-pressed")).toBe("true");

  await user.click(linkButton);
  const field = screen.getByLabelText("Link address") as HTMLInputElement;
  expect(field.value).toBe("https://old.example.com");
  await user.clear(field);
  await user.type(field, "https://new.example.com{Enter}");
  expect(getEditorMarkdown(ed)).toBe("[read](https://new.example.com) this");

  await user.click(screen.getByRole("button", { name: "Link" }));
  await user.click(screen.getByRole("button", { name: "Remove link" }));
  expect(getEditorMarkdown(ed)).toBe("read this");
});

test("list, quote and mark buttons toggle and report their state", async () => {
  const { ed, user } = setup("item", 1, 5);
  const bullets = screen.getByRole("button", { name: "Bulleted list" });
  await user.click(bullets);
  expect(getEditorMarkdown(ed)).toBe("- item");
  await waitFor(() => expect(bullets.getAttribute("aria-pressed")).toBe("true"));

  await user.click(screen.getByRole("button", { name: "Numbered list" }));
  expect(getEditorMarkdown(ed)).toBe("1. item");

  await user.click(screen.getByRole("button", { name: "Numbered list" }));
  await user.click(screen.getByRole("button", { name: "Quote" }));
  expect(getEditorMarkdown(ed)).toBe("> item");

  const bold = screen.getByRole("button", { name: "Bold" });
  await user.click(bold);
  expect(getEditorMarkdown(ed)).toBe("> **item**");
  await waitFor(() => expect(bold.getAttribute("aria-pressed")).toBe("true"));
});

test("the text style menu turns a paragraph into a heading and back", async () => {
  const { ed, user } = setup("Title", 1, 6);
  await user.click(screen.getByRole("button", { name: "Text style: Text" }));
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Heading 2" }),
  );
  expect(getEditorMarkdown(ed)).toBe("## Title");

  await user.click(
    await screen.findByRole("button", { name: "Text style: Heading 2" }),
  );
  await user.click(await screen.findByRole("menuitemradio", { name: "Text" }));
  expect(getEditorMarkdown(ed)).toBe("Title");
});

test("a comment submits on Enter and Escape dismisses the draft", async () => {
  const { user, onCommentSubmit } = setup("some text", 1, 5);
  await user.click(screen.getByRole("button", { name: "Comment" }));
  await user.type(screen.getByRole("textbox"), "Tighten this{Enter}");
  expect(onCommentSubmit).toHaveBeenCalledWith("Tighten this");

  await user.click(screen.getByRole("button", { name: "Comment" }));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("textbox")).toBeNull();
});
