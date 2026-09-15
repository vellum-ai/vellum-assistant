import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { makeImageAttachments } from "@/domains/chat/components/chat-attachments/attachment-fixtures";
import { CameraFrameGrid } from "@/domains/chat/components/chat-attachments/camera-frame-grid";
import * as downloads from "@/domains/chat/components/chat-attachments/download-attachment";
import type { DisplayMessage } from "@/domains/chat/types/types";

function frames(duplicateIds: boolean): DisplayMessage[] {
  return makeImageAttachments(4).map((attachment, index) => ({
    id: `frame-${index}`,
    role: "user",
    textSegments: ["(camera frame)"],
    timestamp: index * 5_000,
    attachments: [
      duplicateIds ? { ...attachment, id: "rehydrated:0" } : attachment,
    ],
  }));
}

function renderGrid(initialFrames: DisplayMessage[]) {
  const client = new QueryClient();
  const ui = (messages: DisplayMessage[]) => (
    <QueryClientProvider client={client}>
      <CameraFrameGrid frames={messages} />
    </QueryClientProvider>
  );
  const result = render(ui(initialFrames));
  return {
    ...result,
    rerender: (messages: DisplayMessage[]) => result.rerender(ui(messages)),
  };
}

afterEach(cleanup);

describe("CameraFrameGrid gallery updates", () => {
  for (const duplicateIds of [false, true]) {
    test.each(["pending hydration", "history prepend"])(
      `keeps the opened frame through %s with ${duplicateIds ? "duplicate legacy" : "distinct"} attachment ids`,
      (update) => {
        const initial = frames(duplicateIds).slice(2);
        if (update === "pending hydration") {
          initial.unshift(
            ...frames(duplicateIds)
              .slice(0, 2)
              .map((frame) => ({
                ...frame,
                attachments: [],
              })),
          );
        }
        const { container, rerender } = renderGrid(initial);
        fireEvent.click(
          container.querySelector<HTMLElement>(
            '[data-message-id="frame-3"] div[role="button"]',
          )!,
        );
        expect(
          within(screen.getByRole("dialog")).getByText("2 / 2"),
        ).toBeTruthy();

        const firstUpdate = frames(duplicateIds).slice(1);
        if (update === "pending hydration") {
          firstUpdate.unshift({ ...frames(duplicateIds)[0]!, attachments: [] });
        }
        rerender(firstUpdate);

        const dialog = within(screen.getByRole("dialog"));
        expect(dialog.getByText("3 / 3")).toBeTruthy();
        expect(dialog.getByAltText("photo-3.png").getAttribute("src")).toBe(
          "https://example.com/photo-3.png",
        );
        fireEvent.click(
          dialog.getByRole("button", { name: "Previous attachment" }),
        );
        expect(dialog.getByAltText("photo-2.png")).toBeTruthy();
        expect(dialog.getByText("2 / 3")).toBeTruthy();

        rerender(frames(duplicateIds));

        expect(dialog.getByAltText("photo-2.png")).toBeTruthy();
        expect(dialog.getByText("3 / 4")).toBeTruthy();
        fireEvent.click(
          dialog.getByRole("button", { name: "Next attachment" }),
        );
        expect(dialog.getByAltText("photo-3.png")).toBeTruthy();
        fireEvent.click(
          dialog.getByRole("button", { name: "Next attachment" }),
        );
        expect(dialog.getByAltText("photo-0.png")).toBeTruthy();
        expect(dialog.getByText("1 / 4")).toBeTruthy();
      },
    );
  }

  test("keeps a failed legacy preview on its frame and downloads its original after hydration", () => {
    const messages = frames(true);
    const download = spyOn(downloads, "downloadAttachment").mockResolvedValue(
      undefined,
    );
    try {
      const { container, rerender } = renderGrid([
        { ...messages[0]!, attachments: [] },
        ...messages.slice(1),
      ]);
      const failedTile = container.querySelector<HTMLElement>(
        '[data-message-id="frame-2"]',
      )!;
      fireEvent.error(failedTile.querySelector("img")!);
      fireEvent.click(failedTile.querySelector('div[role="button"]')!);

      rerender(messages);

      expect(failedTile.querySelector("img")).toBeNull();
      expect(
        Array.from(container.querySelectorAll("img"), (img) => img.src),
      ).toEqual(
        [0, 1, 3].map((index) => `https://example.com/photo-${index}.png`),
      );
      const dialog = within(screen.getByRole("dialog"));
      expect(dialog.getByText("3 / 4")).toBeTruthy();
      expect(
        dialog.getByText(
          "Preview unavailable. The file content was not preserved in chat history.",
        ),
      ).toBeTruthy();
      fireEvent.click(
        within(failedTile).getByRole("button", {
          name: "Download photo-2.png",
        }),
      );
      expect(download.mock.calls[0]?.[0]).toBe(messages[2]!.attachments![0]);
      expect(download.mock.calls[0]?.[0].id).toBe("rehydrated:0");
      expect(download.mock.calls[0]?.[0].previewUrl).toBe(
        "https://example.com/photo-2.png",
      );
    } finally {
      download.mockRestore();
    }
  });
});
