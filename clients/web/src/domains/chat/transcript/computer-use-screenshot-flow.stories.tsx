import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { ActivityStepsPanel } from "@/domains/chat/components/activity-steps-panel";
import {
  makeDisplayAttachment,
  makeImageAttachments,
  SAMPLE_PREVIEWS,
} from "@/domains/chat/components/chat-attachments/attachment-fixtures";
import { MessageFilesPanel } from "@/domains/chat/components/message-files-panel";
import { useTurnStore } from "@/domains/chat/turn-store";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { useViewerStore } from "@/stores/viewer-store";

import { Transcript, type TranscriptHandle } from "./transcript";
import type { TranscriptItem } from "./types";

const START = Date.UTC(2026, 0, 2, 12, 0, 0);

function screenshotCall(
  id: string,
  activity: string,
  previewIndex: number,
  overrides: Partial<ChatMessageToolCall> = {},
): ChatMessageToolCall {
  return {
    id,
    name: "computer_use_screenshot",
    input: { activity },
    imageDataList: [SAMPLE_PREVIEWS[previewIndex]!],
    startedAt: START + previewIndex * 2_000,
    completedAt: START + previewIndex * 2_000 + 1_000,
    ...overrides,
  };
}

function storyMessage(
  id: string,
  contentBlocks: DisplayMessage["contentBlocks"],
  toolCalls: ChatMessageToolCall[],
  attachments?: DisplayMessage["attachments"],
): DisplayMessage {
  return {
    id,
    role: "assistant",
    contentBlocks,
    toolCalls,
    attachments,
    timestamp: START,
  };
}

interface ScreenshotFlowStoryProps {
  message: DisplayMessage;
  streaming?: boolean;
  assistantId?: string | null;
}

/**
 * Production transcript plus the two viewer panels this flow can open. The
 * harness only supplies app layout: transcript cards, galleries, Files, and
 * previews are the shipped components backed by the real viewer store.
 */
function ScreenshotFlowStory({
  message,
  streaming = false,
  assistantId = null,
}: ScreenshotFlowStoryProps) {
  const transcriptRef = useRef<TranscriptHandle>(null);
  const mainView = useViewerStore.use.mainView();
  const activitySteps = useViewerStore.use.activeActivitySteps();
  const messageFiles = useViewerStore.use.activeMessageFiles();
  const closeActivitySteps = useViewerStore.use.closeActivitySteps();
  const closeMessageFiles = useViewerStore.use.closeMessageFiles();

  useLayoutEffect(() => {
    transcriptRef.current?.scrollToLatest({ behavior: "auto" });
  }, []);
  useEffect(() => {
    useViewerStore.setState({
      mainView: "chat",
      activeActivitySteps: null,
      activeMessageFiles: null,
    });
    useTurnStore.setState({ phase: streaming ? "thinking" : "idle" });
    return () => {
      useViewerStore.setState({
        mainView: "chat",
        activeActivitySteps: null,
        activeMessageFiles: null,
      });
      useTurnStore.setState({ phase: "idle" });
    };
  }, [streaming]);

  const items: TranscriptItem[] = [
    { kind: "message", key: message.id, message },
  ];

  return (
    <div className="flex w-full flex-col gap-4 lg:flex-row">
      <div className="h-[720px] w-full max-w-[780px] overflow-hidden rounded-xl border border-[var(--border-base)] bg-[var(--surface-base)]">
        <Transcript
          ref={transcriptRef}
          items={items}
          conversationId="computer-use-screenshot-story"
          assistantId={assistantId}
          onSurfaceAction={() => {}}
        />
      </div>
      {mainView === "activity-steps" && activitySteps ? (
        <div className="h-[640px] w-full shrink-0 lg:w-[480px]">
          <ActivityStepsPanel
            payload={activitySteps}
            assistantId={assistantId}
            onClose={closeActivitySteps}
          />
        </div>
      ) : null}
      {mainView === "message-files" && messageFiles ? (
        <div className="h-[640px] w-full shrink-0 lg:w-[480px]">
          <MessageFilesPanel
            payload={messageFiles}
            onClose={closeMessageFiles}
          />
        </div>
      ) : null}
    </div>
  );
}

const first = screenshotCall("cu-first", "Opening the example dashboard", 0);
const second = screenshotCall(
  "cu-second",
  "Reviewing the dashboard filters",
  1,
);
const latest = screenshotCall(
  "cu-latest",
  "Confirming the completed dashboard",
  2,
);
const streamingLatest = {
  ...latest,
  completedAt: undefined,
  result: undefined,
};

const meta: Meta<typeof ScreenshotFlowStory> = {
  title: "Chat/Transcript/Computer use screenshots",
  component: ScreenshotFlowStory,
  parameters: { layout: "fullscreen", controls: { disable: true } },
};

export default meta;
type Story = StoryObj<typeof ScreenshotFlowStory>;

/** Blank separator blocks keep one live run while only its latest screenshot renders large. */
export const StreamingLatestOnly: Story = {
  args: {
    streaming: true,
    message: storyMessage(
      "streaming-latest",
      [
        { type: "tool_use", toolCall: first },
        { type: "text", text: "\n" },
        { type: "tool_use", toolCall: second },
        { type: "text", text: "  \n" },
        { type: "tool_use", toolCall: streamingLatest },
      ],
      [first, second, streamingLatest],
    ),
  },
};

const smoothInitial = screenshotCall(
  "cu-smooth-initial",
  "Opening the example dashboard",
  0,
);
const smoothNext = screenshotCall(
  "cu-smooth-next",
  "Reviewing the updated dashboard",
  4,
);

function SmoothReplacementStory() {
  const [showNext, setShowNext] = useState(false);
  const calls = showNext ? [smoothInitial, smoothNext] : [smoothInitial];
  const contentBlocks: DisplayMessage["contentBlocks"] = showNext
    ? [
        { type: "tool_use", toolCall: smoothInitial },
        { type: "text", text: "I opened the dashboard." },
        { type: "tool_use", toolCall: smoothNext },
      ]
    : [{ type: "tool_use", toolCall: smoothInitial }];

  return (
    <div className="flex flex-col gap-3 p-4">
      <button
        type="button"
        className="w-fit rounded-md border border-[var(--border-base)] px-3 py-1.5 text-body-small-emphasised"
        onClick={() => setShowNext(true)}
      >
        Show next screenshot
      </button>
      <ScreenshotFlowStory
        streaming
        message={storyMessage(
          "smooth-screenshot-replacement",
          contentBlocks,
          calls,
        )}
      />
    </div>
  );
}

/** A new screenshot keeps the decoded frame stable while its new activity group becomes ready. */
export const SmoothLiveReplacement: Story = {
  args: {
    message: storyMessage(
      "smooth-screenshot-replacement",
      [{ type: "tool_use", toolCall: smoothInitial }],
      [smoothInitial],
    ),
  },
  render: () => <SmoothReplacementStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByTestId("computer-use-screenshot-displayed"),
    ).toHaveAttribute("src", SAMPLE_PREVIEWS[0]);

    await userEvent.click(
      canvas.getByRole("button", { name: "Show next screenshot" }),
    );

    await waitFor(() =>
      expect(
        canvas.getByTestId("computer-use-screenshot-displayed"),
      ).toHaveAttribute("src", SAMPLE_PREVIEWS[4]),
    );
  },
};

/** Settled history hides its provenance-marked automatic attachment strip entry. */
export const SettledAutomaticAttachment: Story = {
  args: {
    message: storyMessage(
      "settled-automatic",
      [
        { type: "tool_use", toolCall: latest },
        { type: "text", text: "The dashboard is ready." },
      ],
      [latest],
      [
        makeDisplayAttachment({
          id: "automatic-latest",
          filename: "dashboard.png",
          previewUrl: SAMPLE_PREVIEWS[2],
          computerUseScreenshot: true,
        }),
      ],
    ),
  },
};

/** Real prose boundaries produce separate activity panels with independent screenshot galleries. */
export const SeparatedActivityGalleries: Story = {
  args: {
    streaming: true,
    message: storyMessage(
      "separated-galleries",
      [
        { type: "tool_use", toolCall: first },
        { type: "text", text: "I opened the dashboard." },
        { type: "tool_use", toolCall: second },
        { type: "text", text: "I checked the filters." },
        { type: "tool_use", toolCall: latest },
      ],
      [first, second, latest],
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Earlier activity" }),
    );
    await userEvent.click(
      canvas.getAllByRole("button", { name: "View steps" })[0]!,
    );
    await expect(
      await canvas.findByRole("button", {
        name: "Preview screenshot from Opening the example dashboard",
      }),
    ).toBeVisible();
  },
};

const explicitScreenshotCopyCall: ChatMessageToolCall = {
  ...latest,
  id: "cu-explicit-copy",
  imageDataList: undefined,
  imageAttachmentIds: ["explicit-copy"],
};

/** An unmarked explicit copy deliberately appears beside the large tool-owned screenshot. */
export const ExplicitScreenshotCopy: Story = {
  args: {
    message: storyMessage(
      "explicit-copy",
      [
        { type: "tool_use", toolCall: explicitScreenshotCopyCall },
        { type: "text", text: "I also attached a copy." },
      ],
      [explicitScreenshotCopyCall],
      [
        makeDisplayAttachment({
          id: "explicit-copy",
          filename: "dashboard-copy.png",
          previewUrl: SAMPLE_PREVIEWS[2],
        }),
      ],
    ),
  },
};

const visibleFiles = [
  makeDisplayAttachment({
    id: "report",
    filename: "dashboard-report.pdf",
    mimeType: "application/pdf",
  }),
  ...makeImageAttachments(5).map((attachment, index) => ({
    ...attachment,
    id: `supporting-${index}`,
    filename: `supporting-${index + 1}.png`,
    previewUrl: SAMPLE_PREVIEWS[(index + 3) % SAMPLE_PREVIEWS.length],
  })),
];

/** The strip omits the automatic screenshot while Files keeps every canonical attachment. */
export const ScreenshotAndCanonicalFiles: Story = {
  args: {
    message: storyMessage(
      "screenshot-and-files",
      [
        { type: "tool_use", toolCall: latest },
        { type: "text", text: "The dashboard and supporting files are ready." },
      ],
      [latest],
      [
        makeDisplayAttachment({
          id: "automatic-latest",
          filename: "dashboard.png",
          previewUrl: SAMPLE_PREVIEWS[2],
          computerUseScreenshot: true,
        }),
        ...visibleFiles,
      ],
    ),
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Show all files (2 more)",
      }),
    );
  },
};

const generatedSummaryCall: ChatMessageToolCall = {
  id: "generated-summary",
  name: "media_generate_image",
  input: { prompt: "A generic dashboard summary" },
  imageDataList: [SAMPLE_PREVIEWS[4]!],
  completedAt: START + 10_000,
};

/** Ordinary generated media remains visible independently of the selected computer screenshot. */
export const MixedToolImages: Story = {
  args: {
    message: storyMessage(
      "mixed-tool-images",
      [
        { type: "tool_use", toolCall: latest },
        { type: "text", text: "I also generated a summary image." },
        { type: "tool_use", toolCall: generatedSummaryCall },
      ],
      [latest, generatedSummaryCall],
    ),
  },
};

/** An older payload without provenance keeps its attachment in the legacy strip. */
export const LegacyMarkerFallback: Story = {
  args: {
    message: storyMessage(
      "legacy-marker-fallback",
      [
        { type: "tool_use", toolCall: latest },
        { type: "text", text: "The dashboard is ready." },
      ],
      [latest],
      [
        makeDisplayAttachment({
          id: "legacy-screenshot",
          filename: "legacy-dashboard.png",
          previewUrl: SAMPLE_PREVIEWS[2],
        }),
      ],
    ),
  },
};

const screenshotFreeCall: ChatMessageToolCall = {
  id: "cu-partial-snapshot",
  name: "computer_use_click",
  input: { activity: "Checking the dashboard" },
  completedAt: START + 12_000,
};

/** A partial snapshot keeps the automatic attachment visible until its tool image arrives. */
export const PartialSnapshotFallback: Story = {
  args: {
    message: storyMessage(
      "partial-snapshot-fallback",
      [
        { type: "tool_use", toolCall: screenshotFreeCall },
        { type: "text", text: "The capture is still being restored." },
      ],
      [screenshotFreeCall],
      [
        makeDisplayAttachment({
          id: "partial-screenshot",
          filename: "dashboard.png",
          previewUrl: SAMPLE_PREVIEWS[2],
          computerUseScreenshot: true,
        }),
      ],
    ),
  },
};

const unavailableLatest: ChatMessageToolCall = {
  ...latest,
  id: "cu-unavailable-latest",
  imageDataList: undefined,
  imageAttachmentIds: ["unavailable-latest"],
};

/** A missing current reference shows its unavailable state without restoring an older screenshot. */
export const UnavailableLatestReference: Story = {
  args: {
    assistantId: null,
    message: storyMessage(
      "unavailable-latest",
      [
        { type: "tool_use", toolCall: first },
        { type: "text", text: "I opened the dashboard." },
        { type: "tool_use", toolCall: unavailableLatest },
        { type: "text", text: "The final capture is unavailable." },
      ],
      [first, unavailableLatest],
    ),
  },
};
