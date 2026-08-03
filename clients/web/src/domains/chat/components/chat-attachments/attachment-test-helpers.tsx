/**
 * Shared fixtures and stubs for the attachment renderers' tests
 * (`BubbleAttachments`, `MessageAttachments`, `MessageFilesPanel`) and the
 * viewer store's message-files actions.
 *
 * The preview-modal stub is exported as a function rather than run on import,
 * because `mock.module` must be applied BEFORE the module under test is
 * imported and a bare side-effecting import gives the test no control over
 * that ordering.
 */

import { mock } from "bun:test";

import type { DisplayAttachment } from "@/domains/chat/types/types";

/**
 * A display attachment with sensible PNG defaults. Pass `overrides` for the
 * fields a test actually cares about.
 */
export function makeDisplayAttachment(
  overrides: Partial<DisplayAttachment> = {},
): DisplayAttachment {
  const id = overrides.id ?? "att-1";
  return {
    id,
    filename: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 1_024,
    previewUrl: null,
    ...overrides,
  };
}

/** `count` distinct image attachments, named `photo-<i>.png`. */
export function makeImageAttachments(count: number): DisplayAttachment[] {
  return Array.from({ length: count }, (_, index) =>
    makeDisplayAttachment({
      id: `img-${index}`,
      filename: `photo-${index}.png`,
      previewUrl: `https://example.com/photo-${index}.png`,
    }),
  );
}

/** A mixed media / non-media set covering each icon fallback kind. */
export function makeMixedAttachments(): DisplayAttachment[] {
  return [
    makeImageAttachments(1)[0]!,
    makeDisplayAttachment({
      id: "deck-1",
      filename: "deck.pptx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      sizeBytes: 4_096,
    }),
    makeDisplayAttachment({
      id: "report-1",
      filename: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2_048,
    }),
    makeDisplayAttachment({
      id: "bundle-1",
      filename: "bundle.zip",
      mimeType: "application/zip",
      sizeBytes: 8_192,
    }),
  ];
}

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
