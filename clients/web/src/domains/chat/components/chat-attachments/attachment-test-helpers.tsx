/**
 * Shared fixtures and stubs for the attachment renderers' tests
 * (`BubbleAttachments`, `MessageAttachments`, `MessageFilesPanel`) and the
 * viewer store's message-files actions.
 *
 * Fixtures live in `attachment-fixtures.ts`, which imports no test runner so
 * stories can share them; this module adds the `bun:test` stubs on top.
 *
 * The preview-modal stub is exported as a function rather than run on import,
 * because `mock.module` must be applied BEFORE the module under test is
 * imported and a bare side-effecting import gives the test no control over
 * that ordering.
 */

import { mock } from "bun:test";

// Re-exported so existing test imports keep resolving from one place; the
// factories themselves live in a test-runner-free module the stories share.
export {
  makeDisplayAttachment,
  makeImageAttachments,
  makeMixedAttachments,
  makePreviewableImages,
  SAMPLE_PREVIEWS,
} from "@/domains/chat/components/chat-attachments/attachment-fixtures";

/**
 * Replace the preview modal with a probe exposing the opened attachment, its
 * preview URL, and its gallery siblings - enough for both the gallery-size
 * assertions and the failed-decode assertions. Call this at module scope,
 * above the import of the component under test.
 */
export function mockAttachmentPreviewModal(): void {
  mock.module(
    "@/domains/chat/components/chat-attachments/attachment-preview-modal",
    () => ({
      AttachmentPreviewModal: ({
        attachment,
        siblingAttachments,
      }: {
        attachment: { id: string; previewUrl: string | null };
        siblingAttachments?: Array<{ id: string; previewUrl: string | null }>;
      }) => (
        <div
          data-testid="preview-modal"
          data-attachment-id={attachment.id}
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
    }),
  );
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
