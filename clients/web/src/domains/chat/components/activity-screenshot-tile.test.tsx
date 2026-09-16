import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

import type { ToolResultImage } from "@/domains/chat/components/chat-attachments/tool-result-images";

const objectUrlHook = mock(
  (
    assistantId: string | null | undefined,
    image: Pick<ToolResultImage, "id" | "previewUrl"> | null,
    enabled: boolean,
  ) => ({
    url:
      image?.previewUrl ??
      (assistantId && enabled ? `blob:${image?.id ?? ""}` : null),
    isError: !image?.previewUrl && !assistantId,
    unavailable: !image?.previewUrl && !assistantId,
    legacyId: false,
    isPending: !image?.previewUrl && !!assistantId && enabled === false,
  }),
);

mock.module(
  "@/domains/chat/components/chat-attachments/use-attachment-object-url",
  () => ({ useAttachmentObjectUrl: objectUrlHook }),
);
mock.module("@/runtime/native-auth", () => ({
  useIsNativePlatform: () => false,
}));

const { ActivityScreenshotTile } =
  await import("@/domains/chat/components/activity-screenshot-tile");

const INLINE: ToolResultImage = {
  id: "tool-image:tc-a:1",
  stripKey: "tool-image:tc-a:1",
  occurrenceKey: "tc-a:1",
  toolCallId: "tc-a",
  filename: "computer-use-screenshot.png",
  mimeType: "image/png",
  sizeBytes: 4,
  previewUrl: "data:image/png;base64,AAAA",
};

afterEach(() => {
  cleanup();
  objectUrlHook.mockClear();
  delete (globalThis as { IntersectionObserver?: unknown })
    .IntersectionObserver;
});

describe("ActivityScreenshotTile", () => {
  test("renders inline bytes immediately and forwards its focusable trigger", () => {
    const triggers: Array<HTMLElement | null> = [];
    const { getByRole } = render(
      <ActivityScreenshotTile
        assistantId="asst-1"
        image={INLINE}
        title="Screenshot from checking the page"
        ariaLabel="Preview screenshot from checking the page"
        onPreview={(value) => {
          triggers.push(value);
        }}
      />,
    );

    const tile = getByRole("button", {
      name: "Preview screenshot from checking the page",
    });
    expect(tile.querySelector("img")?.getAttribute("src")).toBe(
      INLINE.previewUrl,
    );
    fireEvent.click(tile);
    expect(triggers[0]).toBe(tile);
  });

  test("does not enable a referenced fetch until the tile is visible", () => {
    let observerCallback: IntersectionObserverCallback | undefined;
    class Observer {
      constructor(callback: IntersectionObserverCallback) {
        observerCallback = callback;
      }
      observe() {}
      disconnect() {}
    }
    globalThis.IntersectionObserver =
      Observer as unknown as typeof IntersectionObserver;
    const referenced = { ...INLINE, id: "att-ref", previewUrl: null };
    const { getByTestId } = render(
      <ActivityScreenshotTile
        assistantId="asst-1"
        image={referenced}
        title="Screenshot"
        ariaLabel="Preview screenshot"
        onPreview={() => {}}
      />,
    );

    expect(objectUrlHook.mock.calls.at(-1)?.[2]).toBe(false);
    act(() => {
      observerCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    expect(objectUrlHook.mock.calls.at(-1)?.[2]).toBe(true);
    expect(getByTestId("activity-screenshot-tile")).toBeTruthy();
  });

  test("a changed occurrence never displays the previous image", () => {
    const { getByRole, rerender } = render(
      <ActivityScreenshotTile
        assistantId="asst-1"
        image={{ ...INLINE, id: "att-a", previewUrl: null }}
        title="Screenshot A"
        ariaLabel="Preview screenshot A"
        onPreview={() => {}}
      />,
    );
    expect(getByRole("button").querySelector("img")?.getAttribute("src")).toBe(
      "blob:att-a",
    );

    rerender(
      <ActivityScreenshotTile
        assistantId="asst-1"
        image={{
          ...INLINE,
          id: "att-b",
          toolCallId: "tc-b",
          previewUrl: null,
        }}
        title="Screenshot B"
        ariaLabel="Preview screenshot B"
        onPreview={() => {}}
      />,
    );
    expect(getByRole("button").querySelector("img")?.getAttribute("src")).toBe(
      "blob:att-b",
    );
  });

  test("missing assistant and decode errors keep an operable fallback", () => {
    const { getByRole } = render(
      <ActivityScreenshotTile
        assistantId={null}
        image={{ ...INLINE, id: "att-missing", previewUrl: null }}
        title="Computer screenshot"
        ariaLabel="Preview computer screenshot"
        onPreview={() => {}}
      />,
    );
    const tile = getByRole("button", { name: "Preview computer screenshot" });
    expect(tile.querySelector("img")).toBeNull();

    const { getByRole: getInlineRole } = render(
      <ActivityScreenshotTile
        assistantId="asst-1"
        image={INLINE}
        title="Screenshot"
        ariaLabel="Preview inline screenshot"
        onPreview={() => {}}
      />,
    );
    const inlineTile = getInlineRole("button", {
      name: "Preview inline screenshot",
    });
    fireEvent.error(inlineTile.querySelector("img")!);
    expect(inlineTile.querySelector("img")).toBeNull();
  });
});
