/**
 * Tests for `MessageAttachments`.
 *
 * The previous version of this file mocked `AttachmentPreviewModal` via
 * `mock.module()`. Bun's module mocks are process-global, which leaked into
 * `_AttachmentPreviewModal.test.tsx` and replaced the real component with the
 * stub when those tests ran. This file now renders the real modal and asserts
 * on the portal'd DOM instead.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { AppRootProvider } from "@/components/app/core/AppRootContext.js";
import type { DisplayAttachment } from "@/domains/chat/lib/reconcile.js";

import { MessageAttachments } from "@/components/app/assistant/ChatAttachments/_MessageAttachments.js";

let originalFetch: typeof globalThis.fetch;
let originalCreateObjectURL: typeof URL.createObjectURL;
let originalRevokeObjectURL: typeof URL.revokeObjectURL;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalCreateObjectURL = URL.createObjectURL;
  originalRevokeObjectURL = URL.revokeObjectURL;

  // Stub the modal's content fetch + URL helpers so opening it in tests
  // doesn't trigger real network calls.
  globalThis.fetch = mock(
    async () =>
      ({
        ok: true,
        statusText: "OK",
        blob: async () => new Blob(["x"]),
      }) as unknown as Response,
  ) as unknown as typeof globalThis.fetch;
  URL.createObjectURL = mock(() => "blob:mock-url");
  URL.revokeObjectURL = mock(() => {});
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

const makeAttachment = (overrides: Partial<DisplayAttachment> = {}): DisplayAttachment => ({
  id: "att_1",
  filename: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1024,
  previewUrl: null,
  ...overrides,
});

describe("MessageAttachments", () => {
  test("renders nothing when there are no attachments", () => {
    const { container } = render(
      <AppRootProvider>
        <MessageAttachments attachments={[]} />
      </AppRootProvider>,
    );
    // The provider's host `<div class="app-root">` is the first child;
    // MessageAttachments itself renders nothing into that host when empty.
    const appRoot = container.querySelector(".app-root");
    expect(appRoot?.firstChild).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  test("clicking a non-image square opens the preview modal with that attachment", () => {
    const pdfAttachment = makeAttachment({ id: "att_pdf", filename: "spec.pdf" });

    const { container } = render(
      <AppRootProvider>
        <MessageAttachments attachments={[pdfAttachment]} assistantId="asst_1" />
      </AppRootProvider>,
    );

    // Initially the modal isn't rendered (no previewAttachment yet).
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    // Click the square — RTL queries the rendered tree under `container`, but
    // the modal portals to the document root, so we then query `document`.
    const square = container.querySelector('[role="button"]');
    expect(square).not.toBeNull();
    fireEvent.click(square!);

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute("aria-label")).toBe("Preview of spec.pdf");
  });

  test("clicking an image square also opens the preview modal", () => {
    const imageAttachment = makeAttachment({
      id: "att_img",
      filename: "photo.png",
      mimeType: "image/png",
      previewUrl: "https://example.test/photo.png",
    });

    const { container } = render(
      <AppRootProvider>
        <MessageAttachments attachments={[imageAttachment]} assistantId="asst_1" />
      </AppRootProvider>,
    );

    const square = container.querySelector('[role="button"]');
    expect(square).not.toBeNull();
    fireEvent.click(square!);

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute("aria-label")).toBe("Preview of photo.png");
  });
});
