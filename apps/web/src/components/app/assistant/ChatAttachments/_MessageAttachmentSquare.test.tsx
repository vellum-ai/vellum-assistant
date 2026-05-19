/**
 * Tests for `MessageAttachmentSquare`.
 *
 * Static-markup checks use `renderToStaticMarkup` for SSR-friendly assertions
 * (filename truncation, size formatting). The click-handler check uses
 * `@testing-library/react` against the happy-dom global from
 * `web/src/test-setup-dom.cjs`.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageAttachmentSquare } from "@/components/app/assistant/ChatAttachments/_MessageAttachmentSquare.js";
import { formatAttachmentSize, middleTruncate } from "@/components/app/assistant/ChatAttachments/utils.js";

afterEach(cleanup);

describe("MessageAttachmentSquare", () => {
  test("renders filename and size for a non-image attachment", () => {
    const html = renderToStaticMarkup(
      <MessageAttachmentSquare
        filename="report.pdf"
        mimeType="application/pdf"
        sizeBytes={12345}
        previewUrl={null}
      />,
    );

    // Short filename — not truncated, displayed as-is.
    expect(html).toContain("report.pdf");
    // Formatted size (12345 bytes → "12 KB").
    expect(html).toContain(formatAttachmentSize(12345));
    // Full filename available via title attribute for tooltip.
    expect(html).toContain('title="report.pdf"');
  });

  test("middle-truncates a long image filename so the extension stays visible", () => {
    const filename = "photo-of-the-day-2026-04-21-final.jpg";
    const html = renderToStaticMarkup(
      <MessageAttachmentSquare
        filename={filename}
        mimeType="image/jpeg"
        sizeBytes={2048}
        previewUrl="https://example.com/photo.jpg"
      />,
    );

    const truncated = middleTruncate(filename, 18);
    // Sanity: `middleTruncate` should actually shorten this filename.
    expect(truncated).not.toBe(filename);
    // Rendered text uses the middle-truncated form (extension preserved).
    expect(html).toContain(truncated);
    expect(truncated.endsWith(".jpg")).toBe(true);
    // Full filename is still available via the title attribute.
    expect(html).toContain(`title="${filename}"`);
  });

  test("clicking a non-image square invokes onPreview", () => {
    const onPreview = mock(() => {});

    const { container } = render(
      <MessageAttachmentSquare
        filename="report.pdf"
        mimeType="application/pdf"
        sizeBytes={12345}
        previewUrl={null}
        onPreview={onPreview}
      />,
    );

    // Square is the role="button" wrapper at the root of the rendered tree.
    const button = container.querySelector('[role="button"]');
    expect(button).not.toBeNull();
    fireEvent.click(button!);
    expect(onPreview).toHaveBeenCalledTimes(1);
  });
});
