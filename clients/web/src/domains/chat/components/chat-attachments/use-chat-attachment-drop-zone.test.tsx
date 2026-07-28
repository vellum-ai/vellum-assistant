/**
 * Tests for the chat attachment drop zone hook. The critical branch under
 * test is folder-vs-file classification: dropping a folder must route to
 * `onDirectories` (never `onFiles`), because a browser can't read directory
 * contents and the composer would otherwise queue a zero-byte upload that
 * never completes.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";
import { createRef, useImperativeHandle, forwardRef, type Ref } from "react";

import {
  useChatAttachmentDropZone,
  type ChatAttachmentDropZoneHandlers,
} from "@/domains/chat/components/chat-attachments/use-chat-attachment-drop-zone";

interface DropZoneHandle {
  handlers: ChatAttachmentDropZoneHandlers;
}

const DropZoneProbe = forwardRef(function DropZoneProbe(
  props: {
    onFiles: (files: File[]) => void;
    onDirectories?: (directories: File[]) => void;
  },
  ref: Ref<DropZoneHandle>,
) {
  const { dropHandlers } = useChatAttachmentDropZone({
    onFiles: props.onFiles,
    onDirectories: props.onDirectories,
  });
  useImperativeHandle(ref, () => ({ handlers: dropHandlers }), [dropHandlers]);
  return <div data-testid="zone" />;
});

interface DropItemSpec {
  file: File;
  isDirectory: boolean;
}

// Build a DataTransfer-shaped object the hook can iterate. Real
// `DataTransferItem` / `DataTransfer` constructors are not available in
// happy-dom, so we hand-craft the minimum shape the hook consumes.
function makeDataTransfer(items: DropItemSpec[]): DataTransfer {
  const itemObjs = items.map(({ file, isDirectory }) => ({
    kind: "file" as const,
    type: file.type,
    getAsFile: () => file,
    webkitGetAsEntry: () => ({ isDirectory }),
  }));
  return {
    types: ["Files"],
    items: itemObjs as unknown as DataTransferItemList,
    files: {
      length: items.length,
      item: (i: number) => items[i]?.file ?? null,
    } as unknown as FileList,
    dropEffect: "none",
    effectAllowed: "all",
    clearData: () => {},
    getData: () => "",
    setData: () => {},
    setDragImage: () => {},
  } as unknown as DataTransfer;
}

function fireDrop(
  handlers: ChatAttachmentDropZoneHandlers,
  target: HTMLElement,
  dataTransfer: DataTransfer,
): void {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  handlers.onDrop(event as unknown as React.DragEvent<HTMLElement>);
  fireEvent(target, event);
}

afterEach(() => {
  cleanup();
});

describe("useChatAttachmentDropZone", () => {
  test("classifies a dropped folder via webkitGetAsEntry.isDirectory and routes to onDirectories", () => {
    const onFiles = mock((_files: File[]) => {});
    const onDirectories = mock((_dirs: File[]) => {});
    const ref = createRef<DropZoneHandle>();
    const { getByTestId } = render(
      <DropZoneProbe
        ref={ref}
        onFiles={onFiles}
        onDirectories={onDirectories}
      />,
    );

    const folder = new File([], "MyFolder", { type: "" });
    const dataTransfer = makeDataTransfer([
      { file: folder, isDirectory: true },
    ]);

    fireDrop(ref.current!.handlers, getByTestId("zone"), dataTransfer);

    expect(onDirectories).toHaveBeenCalledTimes(1);
    expect(onDirectories.mock.calls[0][0]).toEqual([folder]);
    expect(onFiles).not.toHaveBeenCalled();
  });

  test("routes regular files to onFiles and folders to onDirectories in a mixed drop", () => {
    const onFiles = mock((_files: File[]) => {});
    const onDirectories = mock((_dirs: File[]) => {});
    const ref = createRef<DropZoneHandle>();
    const { getByTestId } = render(
      <DropZoneProbe
        ref={ref}
        onFiles={onFiles}
        onDirectories={onDirectories}
      />,
    );

    const doc = new File(["hello"], "notes.txt", { type: "text/plain" });
    const folder = new File([], "src", { type: "" });
    const dataTransfer = makeDataTransfer([
      { file: doc, isDirectory: false },
      { file: folder, isDirectory: true },
    ]);

    fireDrop(ref.current!.handlers, getByTestId("zone"), dataTransfer);

    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0][0]).toEqual([doc]);
    expect(onDirectories).toHaveBeenCalledTimes(1);
    expect(onDirectories.mock.calls[0][0]).toEqual([folder]);
  });

  test("still routes files when no onDirectories handler is provided (opt-in)", () => {
    const onFiles = mock((_files: File[]) => {});
    const ref = createRef<DropZoneHandle>();
    const { getByTestId } = render(
      <DropZoneProbe ref={ref} onFiles={onFiles} />,
    );

    const file = new File(["ok"], "a.txt", { type: "text/plain" });
    fireDrop(
      ref.current!.handlers,
      getByTestId("zone"),
      makeDataTransfer([{ file, isDirectory: false }]),
    );

    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0][0]).toEqual([file]);
  });
});
