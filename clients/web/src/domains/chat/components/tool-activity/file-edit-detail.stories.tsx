import type { Meta, StoryObj } from "@storybook/react-vite";

import { DetailPanelStoryFrame } from "@/domains/chat/components/detail-panel-story-frame";
import { fileEditDetail } from "@/domains/chat/components/tool-detail-story-fixtures";

import { FileEditDetail } from "./file-edit-detail";

/**
 * The body for `file_edit` and `host_file_edit`. `old_string` and `new_string`
 * are a diff, so they render as one rather than as two JSON string literals
 * with their newlines escaped.
 *
 * The heading is the thing to check across these. The diff describes what the
 * call *asked for*, and only a call that succeeded had it applied, so anything
 * else says "Requested changes": a denied edit under a plain "Changes" heading
 * claims something happened. The daemon returns no applied-diff data, only a
 * sentence, so showing a genuinely applied diff would need a tool-contract
 * change; labelling it honestly is what this can do today.
 */
const meta = {
  title: "Chat/ToolActivity/FileEditDetail",
  component: FileEditDetail,
  decorators: [
    (Story) => (
      <DetailPanelStoryFrame>
        <div className="p-5">
          <Story />
        </div>
      </DetailPanelStoryFrame>
    ),
  ],
} satisfies Meta<typeof FileEditDetail>;

export default meta;
type Story = StoryObj<typeof FileEditDetail>;

const base = {
  detail: fileEditDetail,
  result: fileEditDetail.result,
  streamedOutput: undefined,
  isRunning: false,
  isError: false,
  isDenied: false,
  assistantId: "assistant-1",
};

/** Applied. The only state that earns the plain "Changes" heading. */
export const Applied: Story = { args: base };

/** In flight: nothing has been applied yet, so it reads as requested. */
export const Running: Story = {
  args: { ...base, result: undefined, isRunning: true },
};

/** Failed part-way. The edit did not land, and the heading says so. */
export const Errored: Story = {
  args: {
    ...base,
    result: "Error: string not found in file",
    isError: true,
  },
};

/** Declined at the confirmation, and never applied. */
export const Denied: Story = {
  args: { ...base, result: undefined, isDenied: true },
};

/**
 * The path under its other spelling. The daemon's alias table rewrites
 * `file_path` to `path` for aliased tool names only, so a direct `file_edit`
 * call still carries this one and the header has to accept it.
 */
export const PathAsFilePath: Story = {
  args: {
    ...base,
    detail: {
      ...fileEditDetail,
      input: {
        file_path: "clients/web/src/domains/chat/utils/risk.ts",
        old_string: (fileEditDetail.input as Record<string, unknown>)
          .old_string,
        new_string: (fileEditDetail.input as Record<string, unknown>)
          .new_string,
      },
    },
  },
};

/** A new file: nothing on the left, every line an addition. */
export const NewFile: Story = {
  args: {
    ...base,
    detail: {
      ...fileEditDetail,
      input: {
        path: "clients/web/src/domains/chat/utils/tool-input.ts",
        old_string: "",
        new_string:
          'export const COMMAND_KEYS = ["command", "cmd"] as const;\nexport const FILE_PATH_KEYS = ["file_path", "path", "filePath"] as const;\n',
      },
    },
  },
};
