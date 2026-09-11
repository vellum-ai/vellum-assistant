import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";

import { TiptapDocumentEditor } from "./tiptap-document-editor";

afterEach(cleanup);

test("the same mounted editor honors the send preparation editing barrier", async () => {
  const { container, rerender } = render(
    <TiptapDocumentEditor content="Original body" />,
  );
  const editor = await waitFor(() => {
    const element = container.querySelector(".tiptap");
    expect(element).not.toBeNull();
    return element!;
  });
  expect(editor.getAttribute("contenteditable")).toBe("true");
  rerender(<TiptapDocumentEditor content="Original body" editable={false} />);
  expect(container.querySelector(".tiptap")).toBe(editor);
  expect(editor.getAttribute("contenteditable")).toBe("false");
  rerender(<TiptapDocumentEditor content="Original body" editable />);
  expect(container.querySelector(".tiptap")).toBe(editor);
  expect(editor.getAttribute("contenteditable")).toBe("true");
});

test("an external document update does not trigger an editor autosave", async () => {
  const onContentChange = mock((_markdown: string) => {});
  const { container, rerender } = render(
    <TiptapDocumentEditor content="Original body" onContentChange={onContentChange} />,
  );
  await waitFor(() => expect(container.textContent).toContain("Original body"));
  rerender(
    <TiptapDocumentEditor content="Assistant edit" onContentChange={onContentChange} />,
  );
  await waitFor(() => expect(container.textContent).toContain("Assistant edit"));
  expect(onContentChange).not.toHaveBeenCalled();
});
