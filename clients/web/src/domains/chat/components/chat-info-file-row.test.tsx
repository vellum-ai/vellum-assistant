/**
 * `ChatInfoFileRow`: the top-level row both file categories render through.
 *
 * Camera frames are the case worth pinning, because the panel's own suite
 * cannot reach them: the transcript never carries the frame tag, so the frames
 * row has no source there. What is asserted is the wiring, that the row hands
 * the frames category its own copy, its own drill-in, and frame tiles.
 *
 * The row's measured width is mocked, since happy-dom reports a zero box for
 * everything, and the window-size axis comes from a `matchMedia` stub.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  makeDisplayAttachment,
  SAMPLE_PREVIEWS,
} from "@/domains/chat/components/chat-attachments/attachment-fixtures";
import {
  CHAT_INFO_DRAWER_WIDTH_PX,
  CHAT_INFO_T0,
  CHAT_INFO_TEST_LOCALE,
  installChatInfoDomStubs,
  makeChatInfoQueryClient,
  makeElementSizeMock,
  makeFrameAsset,
} from "@/domains/chat/components/chat-info.test-helper";
import { viewportAxesStub } from "@/hooks/viewport-axes.test-helper";
import { formatCaptureTime } from "@/utils/format-date";

const restoreDomStubs = installChatInfoDomStubs();

mock.module("@/hooks/use-element-size", () =>
  makeElementSizeMock(() => CHAT_INFO_DRAWER_WIDTH_PX),
);

const { ChatInfoFileRow } =
  await import("@/domains/chat/components/chat-info-file-row");

const ASSISTANT_ID = "asst-1";

// A day apart, so the two tiles carry labels that can be told from each other.
const CAPTURED_AT = [CHAT_INFO_T0, CHAT_INFO_T0 - 86_400_000];

const FRAMES = CAPTURED_AT.map((capturedAt, index) =>
  makeFrameAsset(
    makeDisplayAttachment({
      id: `camera-frame-${index + 1}`,
      filename: `camera-frame-${index + 1}.jpg`,
      mimeType: "image/jpeg",
      previewUrl: SAMPLE_PREVIEWS[index]!,
    }),
    capturedAt,
  ),
);

const viewport = viewportAxesStub();

/** More than the two frames on screen, as a paged category would report. */
const FRAMES_TOTAL = 9;

function renderFramesRow(onSeeAll: (category: "files" | "frames") => void) {
  render(
    <QueryClientProvider client={makeChatInfoQueryClient()}>
      <ChatInfoFileRow
        category="frames"
        title="Camera Frames"
        count={FRAMES_TOTAL}
        items={FRAMES}
        seeAllAriaLabel="See all camera frames"
        onSeeAll={onSeeAll}
        onOpen={() => {}}
        assistantId={ASSISTANT_ID}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  viewport.set({ narrow: false, coarsePointer: false });
});

afterEach(() => {
  cleanup();
  viewport.restore();
});

afterAll(() => {
  restoreDomStubs();
  mock.restore();
});

describe("ChatInfoFileRow for camera frames", () => {
  test("heads the row with the frames title and the category's total", () => {
    renderFramesRow(() => {});

    expect(screen.getByText("Camera Frames")).toBeDefined();
    expect(screen.getByText(String(FRAMES_TOTAL))).toBeDefined();
  });

  test("drills into frames from the See All control", () => {
    const drilled: string[] = [];
    renderFramesRow((category) => drilled.push(category));

    fireEvent.click(screen.getByLabelText("See all camera frames"));

    expect(drilled).toEqual(["frames"]);
  });

  test("labels each tile by when it was captured", () => {
    renderFramesRow(() => {});

    expect(screen.getAllByLabelText("Preview camera frame")).toHaveLength(
      FRAMES.length,
    );
    for (const capturedAt of CAPTURED_AT) {
      expect(
        screen.getByText(formatCaptureTime(capturedAt, CHAT_INFO_TEST_LOCALE)),
      ).toBeDefined();
    }
  });
});
