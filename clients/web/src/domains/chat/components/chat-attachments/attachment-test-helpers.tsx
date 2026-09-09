/**
 * Shared stubs for the attachment tests: the renderers (`BubbleAttachments`,
 * `MessageAttachments`, `MessageFilesPanel`), the viewer store's message-files
 * actions, and the file-picker surfaces.
 *
 * Fixtures live in `attachment-fixtures.ts`, which imports no test runner so
 * stories can share them; this module adds the `bun:test` stubs on top and
 * every caller imports the fixtures from there.
 *
 * The preview-modal stub is exported as a function rather than run on import,
 * because `mock.module` must be applied BEFORE the module under test is
 * imported and a bare side-effecting import gives the test no control over
 * that ordering.
 */

import { mock } from "bun:test";
import { fireEvent } from "@testing-library/react";

const PREVIEW_MODAL_MODULE =
  "@/domains/chat/components/chat-attachments/attachment-preview-modal";

/**
 * The real modal, held before any probe replaces it. `mock.module` is
 * process-global and `mock.restore()` leaves one installed, so re-mocking the
 * module with this is the only way back for whatever the runner evaluates
 * after a suite that stubbed it.
 */
const { AttachmentPreviewModal: RealAttachmentPreviewModal } = await import(
  PREVIEW_MODAL_MODULE
);

/**
 * Replace the preview modal with a probe exposing the opened attachment, its
 * preview URL, its gallery position, and its gallery siblings - enough for the
 * gallery-size, gallery-position and failed-decode assertions. Call this at
 * module scope, above the import of the component under test.
 *
 * Returns the restore, which puts the real modal back for the rest of the
 * process.
 */
export function mockAttachmentPreviewModal(): () => void {
  mock.module(PREVIEW_MODAL_MODULE, () => ({
    AttachmentPreviewModal: ({
      attachment,
      siblingAttachments,
      currentIndex,
    }: {
      attachment: { id: string; previewUrl: string | null };
      siblingAttachments?: Array<{ id: string; previewUrl: string | null }>;
      currentIndex?: number;
    }) => (
      <div
        data-testid="preview-modal"
        data-attachment-id={attachment.id}
        data-current-index={String(currentIndex)}
        data-preview-url={String(attachment.previewUrl)}
        data-sibling-count={String((siblingAttachments ?? []).length)}
        data-sibling-preview-urls={JSON.stringify(
          (siblingAttachments ?? []).map((a) => ({
            id: a.id,
            previewUrl: a.previewUrl,
          })),
        )}
      />
    ),
  }));

  return () => {
    mock.module(PREVIEW_MODAL_MODULE, () => ({
      AttachmentPreviewModal: RealAttachmentPreviewModal,
    }));
  };
}

/**
 * A `FileList` over `files`. happy-dom ships no `FileList` constructor, and
 * consumers read both `list.item(i)` and `list[i]`, so the shape is built by
 * hand with both accessors.
 */
export function makeFileList(files: File[]): FileList {
  const list = {
    length: files.length,
    item: (i: number) => files[i] ?? null,
  } as unknown as FileList;
  files.forEach((file, i) => {
    (list as unknown as Record<number, File>)[i] = file;
  });
  return list;
}

/**
 * Drive a hidden `<input type="file">` the way the native picker does: stash
 * the selection on `files` (read-only in the DOM, so it takes a
 * `defineProperty`) and fire `change`. Returns the `FileList` so callers can
 * assert on the exact object handed to their callback.
 */
export function selectFiles(input: HTMLInputElement, files: File[]): FileList {
  const list = makeFileList(files);
  Object.defineProperty(input, "files", { configurable: true, value: list });
  fireEvent.change(input);
  return list;
}

/**
 * The `aria-label` of every attachment square in `container`. Squares are divs
 * with `role="button"`; the download and overflow affordances are real
 * `<button>` elements, so this counts only squares.
 */
export function squareLabels(container: HTMLElement): Array<string | null> {
  return Array.from(container.querySelectorAll('div[role="button"]')).map(
    (el) => el.getAttribute("aria-label"),
  );
}
