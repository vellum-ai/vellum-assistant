/**
 * `ChatInfoFileRow`: the top-level row both file categories render through.
 *
 * What this row owns is the category binding, that the drill-in it offers
 * carries the category it was given. Its header and its tiles belong to
 * `ChatInfoSection` and `ChatInfoFileTile`, which have suites of their own.
 *
 * Camera frames are the case worth pinning, because the panel's own suite
 * cannot reach them: the transcript never carries the frame tag, so the frames
 * row has no source there.
 *
 * The row's measured width is mocked, since happy-dom reports a zero box for
 * everything, and the window-size axis comes from a `matchMedia` stub. Copy
 * comes from the catalog through `t()`, on the locale pinned below.
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
  CHAT_INFO_BODY_WIDTH_PX,
  CHAT_INFO_T0,
  CHAT_INFO_TEST_LOCALE,
  installChatInfoDomStubs,
  makeChatInfoQueryClient,
  makeElementSizeMock,
  makeFrameAsset,
} from "@/domains/chat/components/chat-info.test-helper";
import { viewportAxesStub } from "@/hooks/viewport-axes.test-helper";
import { t } from "@/i18n";
import { stubHostLanguage } from "@/i18n/host-language.test-helper";

const restoreDomStubs = installChatInfoDomStubs();
const restoreHostLanguage = stubHostLanguage(CHAT_INFO_TEST_LOCALE);

mock.module("@/hooks/use-element-size", () =>
  makeElementSizeMock(() => CHAT_INFO_BODY_WIDTH_PX),
);

const { ChatInfoFileRow } =
  await import("@/domains/chat/components/chat-info-file-row");

const ASSISTANT_ID = "asst-1";

// Two captures, so the row draws a tile per frame rather than a single one.
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
        title={t("chat:chatInfoPanel.framesTitle")}
        count={FRAMES_TOTAL}
        items={FRAMES}
        seeAllAriaLabel={t("chat:chatInfoPanel.seeAllFramesAria")}
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
  restoreHostLanguage();
  mock.restore();
});

describe("ChatInfoFileRow for camera frames", () => {
  test("drills into frames from the See All control", () => {
    const drilled: string[] = [];
    renderFramesRow((category) => drilled.push(category));

    fireEvent.click(
      screen.getByLabelText(t("chat:chatInfoPanel.seeAllFramesAria")),
    );

    expect(drilled).toEqual(["frames"]);
  });
});
