import type { Meta, StoryObj } from "@storybook/react-vite";

import { DetailPanelStoryFrame } from "@/domains/chat/components/detail-panel-story-frame";
import { fileWriteDetail } from "@/domains/chat/components/tool-detail-story-fixtures";

import { FileWriteDetail } from "./file-write-detail";

/**
 * The body for `file_write` and `host_file_write`.
 *
 * A write is the sibling of an edit, and the two used to read very differently:
 * an edit's before-and-after pair became a diff while a write's whole file
 * stayed a JSON string literal, quotes escaped and newlines printed as the
 * characters `\n`. It is the same file either way, so it is legible either way.
 *
 * Content rather than an all-green diff, because the call carries no "before".
 * A write replaces whatever was on disk, and gutters would imply we know what
 * that was.
 */
const meta = {
  title: "Chat/ToolActivity/FileWriteDetail",
  component: FileWriteDetail,
  decorators: [
    (Story) => (
      <DetailPanelStoryFrame>
        <div className="p-5">
          <Story />
        </div>
      </DetailPanelStoryFrame>
    ),
  ],
} satisfies Meta<typeof FileWriteDetail>;

export default meta;
type Story = StoryObj<typeof FileWriteDetail>;

const base = {
  detail: fileWriteDetail,
  result: fileWriteDetail.result,
  streamedOutput: undefined,
  isRunning: false,
  isError: false,
  isDenied: false,
  assistantId: "assistant-1",
};

/** A source file written in full. */
export const Written: Story = { args: base };

/** The path under its other spelling, which a direct call still sends. */
export const PathAsFilePath: Story = {
  args: {
    ...base,
    detail: {
      ...fileWriteDetail,
      input: {
        file_path: "clients/web/docs/CONVENTIONS.md",
        content: "# Conventions\n\nA story is a public document.\n",
      },
    },
  },
};

/**
 * Writing an empty file. The content block is empty rather than absent, which
 * is the truth: the call wrote nothing into a real file.
 */
export const EmptyFile: Story = {
  args: {
    ...base,
    detail: {
      ...fileWriteDetail,
      input: { path: "clients/web/src/domains/chat/.keep", content: "" },
    },
  },
};

/** Long enough to clamp, so the section below it stays on screen. */
export const LongFileClamps: Story = {
  args: {
    ...base,
    detail: {
      ...fileWriteDetail,
      input: {
        path: "clients/web/src/generated/daemon/types.gen.ts",
        content: Array.from(
          { length: 90 },
          (_, i) =>
            `export interface Generated${i} { id: string; name: string }`,
        ).join("\n"),
      },
    },
  },
};
