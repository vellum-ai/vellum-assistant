import {
  afterAll,
  afterEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { cleanup, fireEvent, render, within } from "@testing-library/react";

import { mockAttachmentPreviewModal } from "@/domains/chat/components/chat-attachments/attachment-test-helpers";

const restorePreviewModal = mockAttachmentPreviewModal();

import { makeDisplayAttachment } from "@/domains/chat/components/chat-attachments/attachment-fixtures";
import { CameraFrameGrid } from "@/domains/chat/components/chat-attachments/camera-frame-grid";
import * as downloads from "@/domains/chat/components/chat-attachments/download-attachment";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { formatLocalTimeWithSeconds } from "@/utils/format-date";

const SAVED_AT = new Date(2026, 8, 1, 14, 30).getTime();

function frame(index: number, pending = false): DisplayMessage {
  return {
    id: `frame-${index}`,
    role: "user",
    textSegments: ["(camera frame)"],
    timestamp: SAVED_AT + index * 5_000,
    attachments: pending
      ? []
      : [
          makeDisplayAttachment({
            id: `attachment-${index}`,
            filename: `frame-${index}.png`,
            previewUrl: `https://example.com/frame-${index}.png`,
          }),
        ],
  };
}

function tile(container: HTMLElement, id: number): HTMLElement {
  return container.querySelector<HTMLElement>(
    `[data-message-id="frame-${id}"]`,
  )!;
}

afterAll(() => {
  restorePreviewModal();
  mock.restore();
});
afterEach(() => {
  cleanup();
});

describe("CameraFrameGrid", () => {
  test("keeps every loaded frame in order and addressable through a long run", () => {
    const frames = Array.from({ length: 120 }, (_, index) => frame(index));
    const { container, getByText, getByTestId } = render(
      <CameraFrameGrid frames={frames} />,
    );

    const tiles = Array.from(
      container.querySelectorAll<HTMLElement>("[data-message-id]"),
    );
    expect(tiles.map((entry) => entry.getAttribute("data-message-id"))).toEqual(
      frames.map((entry) => entry.id),
    );
    expect(tiles.map((entry) => entry.id)).toEqual(
      frames.map((entry) => `msg-${entry.id}`),
    );
    expect(document.getElementById("msg-frame-119")).toBe(tiles[119]);
    expect(getByText("120 camera frames")).toBeTruthy();
    expect(container.textContent).not.toContain("(camera frame)");
    fireEvent.click(
      tile(container, 119).querySelector<HTMLElement>('div[role="button"]')!,
    );
    expect(
      getByTestId("preview-modal").getAttribute("data-current-index"),
    ).toBe("119");
    expect(
      getByTestId("preview-modal").getAttribute("data-sibling-count"),
    ).toBe("120");
  });

  test("shows saved times five seconds apart visibly, including for pending frames", () => {
    const { container, getByText } = render(
      <CameraFrameGrid frames={[frame(0), frame(1, true)]} />,
    );

    expect(getByText(formatLocalTimeWithSeconds(SAVED_AT))).toBeTruthy();
    expect(
      getByText(formatLocalTimeWithSeconds(SAVED_AT + 5_000)),
    ).toBeTruthy();
    expect(
      tile(container, 0).querySelector("[title]")?.getAttribute("title"),
    ).toMatch(/^Saved /);
    expect(
      within(tile(container, 1)).getByRole("img", {
        name: /Camera frame, image still loading\. Saved/,
      }),
    ).toBeTruthy();
    expect(container.textContent).not.toContain("frame-0.png");
    expect(container.textContent).not.toContain("1.0 KB");
  });

  test("preserves anchors and label geometry when pending images hydrate", () => {
    const pending = frame(0, true);
    const { container, rerender } = render(
      <CameraFrameGrid frames={[pending]} />,
    );
    const anchor = tile(container, 0);
    const square = anchor.firstElementChild!;
    const structure = Array.from(square.children, (child) => child.className);
    const rootClass = square.className;
    const text = square.textContent;
    expect(square.querySelector(".h-16.w-16")).toBeTruthy();

    rerender(<CameraFrameGrid frames={[frame(0)]} />);

    expect(tile(container, 0)).toBe(anchor);
    const hydrated = anchor.firstElementChild!;
    expect(hydrated.className.replace(" cursor-pointer", "")).toBe(rootClass);
    expect(Array.from(hydrated.children, (child) => child.className)).toEqual(
      structure,
    );
    expect(hydrated.textContent).toBe(text);
    expect(hydrated.querySelector(".h-16.w-16")).toBeTruthy();
    expect(within(container).getByText("1 camera frame")).toBeTruthy();
  });

  test("handles absent, invalid, and zero timestamps without losing tiles", () => {
    const { container, getByText } = render(
      <CameraFrameGrid
        frames={[
          { ...frame(0), timestamp: undefined },
          { ...frame(1), timestamp: Number.NaN },
          { ...frame(2), timestamp: Number.POSITIVE_INFINITY },
          { ...frame(3), timestamp: 0 },
        ]}
      />,
    );

    expect(
      container.querySelectorAll<HTMLElement>("[data-message-id]").length,
    ).toBe(4);
    expect(container.textContent).not.toContain("Invalid Date");
    expect(
      within(tile(container, 0)).getByText("Time unavailable"),
    ).toBeTruthy();
    expect(getByText(formatLocalTimeWithSeconds(0))).toBeTruthy();
  });

  test("mixed pending tiles preserve preview, failure, and download attachment indexes", () => {
    const first = frame(1);
    const second = frame(3);
    second.attachments![0]!.id = first.attachments![0]!.id;
    const download = spyOn(downloads, "downloadAttachment").mockResolvedValue(
      undefined,
    );
    try {
      const { container, getByTestId } = render(
        <CameraFrameGrid
          frames={[
            frame(0, true),
            first,
            frame(2, true),
            second,
            frame(4, true),
          ]}
          assistantId="assistant-123"
        />,
      );
      const firstTile = tile(container, 1);
      const secondTile = tile(container, 3);
      fireEvent.click(
        firstTile.querySelector<HTMLElement>('div[role="button"]')!,
      );
      expect(
        getByTestId("preview-modal").getAttribute("data-current-index"),
      ).toBe("0");
      fireEvent.click(
        secondTile.querySelector<HTMLElement>('div[role="button"]')!,
      );
      let modal = getByTestId("preview-modal");
      expect(modal.getAttribute("data-current-index")).toBe("1");
      expect(modal.getAttribute("data-preview-url")).toBe(
        second.attachments![0]!.previewUrl,
      );
      expect(
        JSON.parse(modal.getAttribute("data-sibling-preview-urls")!),
      ).toEqual(
        [first, second].map((entry) => ({
          id: entry.attachments![0]!.id,
          previewUrl: entry.attachments![0]!.previewUrl,
        })),
      );

      fireEvent.error(secondTile.querySelector("img")!);
      expect(firstTile.querySelector("img")).toBeTruthy();
      expect(secondTile.querySelector("img")).toBeNull();
      fireEvent.click(
        secondTile.querySelector<HTMLElement>('div[role="button"]')!,
      );
      modal = getByTestId("preview-modal");
      expect(modal.getAttribute("data-preview-url")).toBe("null");
      expect(modal.getAttribute("data-current-index")).toBe("1");

      fireEvent.click(
        within(firstTile).getByRole("button", { name: "Download frame-1.png" }),
      );
      fireEvent.click(
        within(secondTile).getByRole("button", {
          name: "Download frame-3.png",
        }),
      );
      expect(download.mock.calls).toEqual([
        [first.attachments![0], "assistant-123"],
        [second.attachments![0], "assistant-123"],
      ]);
    } finally {
      download.mockRestore();
    }
  });

  test("renders nothing for an empty run", () => {
    const { container } = render(<CameraFrameGrid frames={[]} />);
    expect(container.textContent).toBe("");
    expect(container.children.length).toBe(0);
  });
});
