import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TranscriptRow } from "@/domains/chat/transcript/transcript-row";
import {
  cameraFrame,
  message,
} from "@/domains/chat/transcript/transcript-story-fixtures";
import type { MessageItem } from "@/domains/chat/transcript/types";

afterEach(cleanup);

const previewUrl =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="green"/></svg>',
  );
const frames = Array.from({ length: 3 }, (_, index) =>
  cameraFrame(`frame-${index}`, {
    timestamp: Date.UTC(2026, 0, 2, 12, 0, index * 5),
    previewUrl: index === 1 ? undefined : previewUrl,
  }),
);
const standalone: MessageItem = {
  kind: "message",
  key: frames[0]!.id,
  message: frames[0]!,
  cameraFrames: frames,
};
const utterance: MessageItem = {
  ...message("utterance-123", "user", "What is this?"),
  cameraFrames: frames,
};

describe("camera frames in transcript rows", () => {
  test("renders utterance text and every frame in one bubble with unique anchors", () => {
    const { container, getByText } = render(
      <TranscriptRow item={utterance} onSurfaceAction={() => {}} />,
    );
    const bubble = getByText("What is this?").closest(".rounded-lg");
    expect(bubble).toBeTruthy();
    for (const frame of frames) {
      const tile = container.querySelector(`#msg-${frame.id}`);
      expect(tile).toBeTruthy();
      expect(bubble!.contains(tile)).toBe(true);
      expect(container.querySelectorAll(`#msg-${frame.id}`)).toHaveLength(1);
    }
    expect(container.querySelector("#msg-utterance-123")).toBeTruthy();
    expect(container.textContent).not.toContain("(camera frame)");
  });

  test("standalone groups omit sentinel text, duplicate images, and text actions", () => {
    const { container, queryByRole } = render(
      <TranscriptRow item={standalone} onSurfaceAction={() => {}} />,
    );
    expect(container.textContent).not.toContain("(camera frame)");
    expect(container.querySelectorAll("img")).toHaveLength(2);
    expect(container.querySelectorAll("#msg-frame-0")).toHaveLength(1);
    expect(queryByRole("button", { name: /^Copy$/ })).toBeNull();
    expect(queryByRole("button", { name: /^Read aloud$/ })).toBeNull();
  });

  test.each([standalone, utterance])(
    "actions use the visible group's cutoff for $key",
    (item) => {
      const fork = mock();
      const summarize = mock();
      const inspect = mock();
      const { getByRole } = render(
        <TranscriptRow
          item={item}
          onSurfaceAction={() => {}}
          onForkConversation={fork}
          onSummarizeUpToHere={summarize}
          onInspectMessage={inspect}
        />,
      );
      fireEvent.click(getByRole("button", { name: "Fork from here" }));
      fireEvent.click(getByRole("button", { name: "Summarize up to here" }));
      fireEvent.click(getByRole("button", { name: "Inspect" }));
      const cutoff = item === standalone ? frames.at(-1)!.id : item.message.id;
      expect(fork).toHaveBeenCalledWith(cutoff);
      expect(summarize).toHaveBeenCalledWith(cutoff);
      expect(inspect).toHaveBeenCalledWith(item.message.id);
    },
  );

  test("ordinary attachments precede the frame grid and text actions stay available", () => {
    const item = {
      ...utterance,
      message: {
        ...utterance.message,
        attachments: [
          {
            id: "att-own",
            filename: "own.png",
            mimeType: "image/png",
            sizeBytes: 128,
            previewUrl,
          },
        ],
      },
    };
    const { container, getByRole } = render(
      <TranscriptRow item={item} onSurfaceAction={() => {}} />,
    );
    const own = getByRole("button", { name: "own.png" });
    const firstFrame = container.querySelector("#msg-frame-0")!;
    expect(
      own.compareDocumentPosition(firstFrame) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(getByRole("button", { name: /^Copy$/ })).toBeTruthy();
  });

  test("rehosting closes the preview and retains every frame anchor", () => {
    const queryClient = new QueryClient();
    const { container, rerender } = render(
      <TranscriptRow
        key={standalone.key}
        item={standalone}
        onSurfaceAction={() => {}}
      />,
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        ),
      },
    );
    fireEvent.click(container.querySelector('#msg-frame-0 [role="button"]')!);
    expect(screen.getByRole("dialog")).toBeTruthy();
    rerender(
      <TranscriptRow
        key={utterance.key}
        item={utterance}
        onSurfaceAction={() => {}}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    for (const frame of frames) {
      expect(container.querySelectorAll(`#msg-${frame.id}`)).toHaveLength(1);
    }
  });

  test.each([standalone, utterance])(
    "touch actions preserve the group's text visibility and cutoff for $key",
    async (item) => {
      const matchMedia = window.matchMedia;
      const pointer = spyOn(window, "matchMedia").mockImplementation(
        (query) => {
          const result = matchMedia.call(window, query);
          if (query === "(pointer: coarse)") {
            Object.defineProperty(result, "matches", { value: true });
          }
          return result;
        },
      );
      try {
        const summarize = mock();
        const { container } = render(
          <TranscriptRow
            item={item}
            onSurfaceAction={() => {}}
            onSummarizeUpToHere={summarize}
          />,
        );
        const wrapper = container.querySelector('[data-message-role="user"]')!;
        fireEvent.touchStart(wrapper, {
          touches: [{ clientX: 50, clientY: 50 }],
        });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 550));
        });
        fireEvent.touchEnd(wrapper);
        const sheet = within(screen.getByRole("dialog"));
        expect(Boolean(sheet.queryByText("Copy", { exact: true }))).toBe(
          item === utterance,
        );
        expect(Boolean(sheet.queryByText("Read aloud", { exact: true }))).toBe(
          item === utterance,
        );
        fireEvent.click(sheet.getByText("Summarize up to here"));
        expect(summarize).toHaveBeenCalledWith(
          item === standalone ? frames.at(-1)!.id : item.message.id,
        );
      } finally {
        cleanup();
        pointer.mockRestore();
      }
    },
  );
});
