import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";

import { useViewerStore } from "@/stores/viewer-store";

import { ChatMarkdownMessage } from "./chat-markdown-message";

const meta: Meta<typeof ChatMarkdownMessage> = {
  title: "Chat/ChatMarkdownMessage",
  component: ChatMarkdownMessage,
  parameters: { layout: "padded" },
  decorators: [
    function FileLinks(Story) {
      useEffect(() => {
        useViewerStore.setState({
          mainView: "chat",
          openedDocumentState: null,
        });
        return () => useViewerStore.getState().closeDocument();
      }, []);
      return (
        <div className="max-w-xl">
          <Story />
        </div>
      );
    },
  ],
  args: {
    assistantId: "asst-1",
    content: [
      "Here are the files:",
      "- [Download the edited picture](vellum://workspace/media/generated/chart.png)",
      "- [Download the notes](/workspace/reports/notes.pdf)",
      "- [Download the image](/workspace/media/generated/landscape_with_mountains_and_a_river_at_sunset_version_123456789.png)",
    ].join("\n"),
  },
};

export default meta;
type Story = StoryObj<typeof ChatMarkdownMessage>;

export const FileActions: Story = {};

export const MobileFileActions: Story = {
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};

export const UserAuthoredLinks: Story = {
  args: {
    fileLinkLabels: "markdown",
    content: "Please edit [**my chart**](vellum://workspace/chart.png).",
  },
};
