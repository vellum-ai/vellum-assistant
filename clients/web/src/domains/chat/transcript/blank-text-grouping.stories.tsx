import { useEffect, useLayoutEffect, useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { useTurnStore } from "@/domains/chat/turn-store";
import type { DisplayMessage } from "@/domains/chat/types/types";

import { Transcript, type TranscriptHandle } from "./transcript";
import { message } from "./transcript-story-fixtures";
import { TranscriptStoryFrame } from "./transcript-story-frame";
import type { MessageItem, TranscriptItem } from "./types";

function ordinaryAssistantMessage(id: string, streaming: boolean): MessageItem {
  const firstTool = {
    id: `${id}-read`,
    name: "read_file",
    input: { path: "/workspace/STATUS.md" },
    startedAt: 1_717_000_000_000,
    completedAt: 1_717_000_001_000,
  };
  const secondTool = {
    id: `${id}-command`,
    name: "bash",
    input: { command: "git status" },
    startedAt: 1_717_000_001_000,
    ...(streaming ? {} : { completedAt: 1_717_000_003_000 }),
  };
  const displayMessage: DisplayMessage = {
    id,
    role: "assistant",
    contentBlocks: [
      {
        type: "thinking",
        thinking: "I will inspect the current state first.",
        startedAt: 1_717_000_000_000,
        completedAt: 1_717_000_000_500,
      },
      { type: "text", text: "\n" },
      { type: "tool_use", toolCall: firstTool },
      { type: "text", text: "  \n" },
      {
        type: "thinking",
        thinking: "The state is clear. I will check the working tree.",
        startedAt: 1_717_000_001_000,
        ...(streaming ? {} : { completedAt: 1_717_000_001_500 }),
      },
      { type: "text", text: "\t" },
      { type: "tool_use", toolCall: secondTool },
      { type: "text", text: "\n" },
    ],
  };
  return { kind: "message", key: id, message: displayMessage };
}

function BlankTextTranscript({ streaming }: { streaming: boolean }) {
  const transcriptRef = useRef<TranscriptHandle>(null);
  useLayoutEffect(() => {
    transcriptRef.current?.scrollToLatest({ behavior: "auto" });
  }, []);
  useEffect(() => {
    useTurnStore.setState({ phase: streaming ? "thinking" : "idle" });
    return () => useTurnStore.setState({ phase: "idle" });
  }, [streaming]);

  const items: TranscriptItem[] = [
    message("blank-text-user", "user", "Check the repository status."),
    ordinaryAssistantMessage("blank-text-assistant", streaming),
  ];
  return (
    <Transcript
      ref={transcriptRef}
      items={items}
      conversationId="blank-text-grouping"
      onSurfaceAction={() => {}}
    />
  );
}

const meta: Meta<typeof BlankTextTranscript> = {
  title: "Chat/Transcript/Blank text grouping",
  component: BlankTextTranscript,
  parameters: { layout: "centered", controls: { disable: true } },
  decorators: [
    (Story) => (
      <TranscriptStoryFrame>
        <Story />
      </TranscriptStoryFrame>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof BlankTextTranscript>;

export const Settled: Story = { args: { streaming: false } };

export const Streaming: Story = { args: { streaming: true } };
