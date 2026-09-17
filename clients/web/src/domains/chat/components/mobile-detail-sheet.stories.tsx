import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { PortalContainerProvider } from "@vellumai/design-library/utils/portal-container";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import {
  Transcript,
  type TranscriptHandle,
} from "@/domains/chat/transcript/transcript";
import { message } from "@/domains/chat/transcript/transcript-story-fixtures";
import type { TranscriptItem } from "@/domains/chat/transcript/types";
import { useViewerStore } from "@/stores/viewer-store";

import { MobileToolDetailOverlay } from "./mobile-tool-detail-overlay";
import { MobileActivityStepsOverlay } from "./mobile-activity-steps-overlay";

const call: ChatMessageToolCall = {
  id: "sheet-tool-1",
  name: "bash",
  input: { command: "ls", activity: "Listing the project files" },
  result: Array.from(
    { length: 50 },
    (_, index) => `example-${index + 1}.txt`,
  ).join("\n"),
  completedAt: 1,
};

interface MobileDetailSheetStoryProps {
  grouped: boolean;
}

/** Real transcript rows open the same viewer panels used by the chat route. */
function MobileDetailSheetStory({ grouped }: MobileDetailSheetStoryProps) {
  const transcript = useRef<TranscriptHandle>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const mainView = useViewerStore.use.mainView();
  const detail = useViewerStore.use.activeToolDetail();
  const steps = useViewerStore.use.activeActivitySteps();
  const closeDetail = useViewerStore.use.closeToolDetail();
  const closeSteps = useViewerStore.use.closeActivitySteps();
  const calls = grouped ? [call, { ...call, id: "sheet-tool-2" }] : [call];
  const items: TranscriptItem[] = [
    ...Array.from({ length: 12 }, (_, index) =>
      message(
        `history-${index}`,
        index % 2 === 0 ? "user" : "assistant",
        "Review the example project and explain the next steps. This message keeps the conversation scrollable.",
      ),
    ),
    message("request", "user", "Show me the project files."),
    {
      kind: "message",
      key: "detail-source",
      message: {
        id: "detail-source",
        role: "assistant",
        contentBlocks: calls.map((toolCall) => ({
          type: "tool_use",
          toolCall,
        })),
        toolCalls: calls,
      },
    },
  ];

  useLayoutEffect(() => {
    transcript.current?.scrollToLatest({ behavior: "auto" });
  }, []);
  useEffect(() => {
    useViewerStore.setState({
      mainView: "chat",
      activeToolDetail: null,
      activeActivitySteps: null,
    });
    return () => {
      useViewerStore.setState({
        mainView: "chat",
        activeToolDetail: null,
        activeActivitySteps: null,
      });
    };
  }, []);

  return (
    <>
      <div
        data-slot="chat-body"
        tabIndex={-1}
        className="h-dvh bg-[var(--surface-base)]"
      >
        <Transcript
          ref={transcript}
          items={items}
          conversationId="sheet-example"
          onSurfaceAction={() => {}}
        />
      </div>
      <div ref={setHost} />
      <PortalContainerProvider container={host}>
        <MobileToolDetailOverlay
          detail={mainView === "tool-detail" ? detail : null}
          onClose={closeDetail}
        />
        <MobileActivityStepsOverlay
          payload={mainView === "activity-steps" ? steps : null}
          onClose={closeSteps}
        />
      </PortalContainerProvider>
    </>
  );
}

const meta: Meta<typeof MobileDetailSheetStory> = {
  title: "Chat/MobileDetailSheet",
  component: MobileDetailSheetStory,
  parameters: { layout: "fullscreen" },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
  args: { grouped: false },
  argTypes: { grouped: { control: "boolean" } },
};

export default meta;
type Story = StoryObj<typeof MobileDetailSheetStory>;

export const SingleTool: Story = {};
export const GroupedActivity: Story = { args: { grouped: true } };

export const ReturnToConversation: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const trigger = await page.findByRole("button", {
      name: "View details: Listing the project files",
    });
    const scroller = page.getByTestId("transcript-scroll-container");
    trigger.scrollIntoView({ block: "nearest" });
    const before = scroller.scrollTop;
    await userEvent.click(trigger);
    const dialog = await page.findByRole("dialog", {
      name: "Activity details",
    });
    const surface = dialog.querySelector<HTMLElement>(
      '[data-slot="bottom-sheet-content-inner"]',
    )!;
    await waitFor(() => {
      expect(surface.getBoundingClientRect().top).toBeGreaterThan(20);
      expect(surface.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        window.innerHeight + 1,
      );
    });
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(page.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
    await expect(scroller.scrollTop).toBe(before);
  },
};
