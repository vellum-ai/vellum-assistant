import type { Meta, StoryObj } from "@storybook/react-vite";

import { DetailPanelStoryFrame } from "@/domains/chat/components/detail-panel-story-frame";
import {
  fileEditDetail,
  fileWriteDetail,
} from "@/domains/chat/components/tool-detail-story-fixtures";

import { FileChangeDetail } from "./file-change-detail";

/**
 * The body for every tool that changes one file: `file_edit`, `file_write` and
 * their `host_` twins.
 *
 * Read this page in pairs. An edit and a write are the same event with
 * different amounts of detail attached, so they share a label pair rather than
 * each inventing wording, and the rule that only a successful call reads as
 * "Changes" holds for both. Which body renders follows the tool rather than
 * the input keys, so a write carrying an unread `old_string` still shows its
 * file.
 */
const meta = {
  title: "Chat/ToolActivity/FileChangeDetail",
  component: FileChangeDetail,
  decorators: [
    (Story) => (
      <DetailPanelStoryFrame>
        <div className="p-5">
          <Story />
        </div>
      </DetailPanelStoryFrame>
    ),
  ],
} satisfies Meta<typeof FileChangeDetail>;

export default meta;
type Story = StoryObj<typeof FileChangeDetail>;

const base = {
  streamedOutput: undefined,
  isRunning: false,
  isError: false,
  isDenied: false,
  assistantId: "assistant-1",
};
const edit = { ...base, detail: fileEditDetail, result: fileEditDetail.result };
const write = {
  ...base,
  detail: fileWriteDetail,
  result: fileWriteDetail.result,
};

/** An edit that landed: both sides are known, so it renders as a diff. */
export const EditApplied: Story = { args: edit };

/** A write that landed: only the after is known, so the content stands alone. */
export const WriteApplied: Story = { args: write };

/** Declined. The diff is what was asked for, and the heading says so. */
export const EditDenied: Story = {
  args: { ...edit, result: undefined, isDenied: true },
};

/**
 * Declined, the other tool. The heading has to say the same thing here, which
 * is the whole reason these share a component.
 */
export const WriteDenied: Story = {
  args: { ...write, result: undefined, isDenied: true },
};

/** In flight, so nothing has been applied yet. */
export const EditRunning: Story = {
  args: { ...edit, result: undefined, isRunning: true },
};

/** Failed part-way: the edit did not land. */
export const EditErrored: Story = {
  args: { ...edit, result: "Error: string not found in file", isError: true },
};

/**
 * The path under its other spelling. The daemon's alias table rewrites
 * `file_path` to `path` for aliased tool names only, so a direct call still
 * carries this one.
 */
export const PathAsFilePath: Story = {
  args: {
    ...write,
    detail: {
      ...fileWriteDetail,
      input: {
        file_path: "clients/web/docs/CONVENTIONS.md",
        content: "# Conventions\n\nA story is a public document.\n",
      },
    },
  },
};

/** Writing an empty file: empty content, not an absent section. */
export const WriteEmptyFile: Story = {
  args: {
    ...write,
    detail: {
      ...fileWriteDetail,
      input: { path: "clients/web/src/domains/chat/.keep", content: "" },
    },
  },
};

/** A new file created by an edit: nothing on the left, all additions. */
export const EditCreatesFile: Story = {
  args: {
    ...edit,
    detail: {
      ...fileEditDetail,
      input: {
        path: "clients/web/src/domains/chat/utils/tool-input.ts",
        old_string: "",
        new_string:
          'export const COMMAND_KEYS = ["command", "cmd"] as const;\n',
      },
    },
  },
};

/**
 * A write whose input carries an unread `old_string`. The write schemas are
 * `z.looseObject`, so this is a valid call; keying the rendering off the input
 * would show an empty diff in place of the file.
 */
export const WriteWithStrayEditKeys: Story = {
  args: {
    ...write,
    detail: {
      ...fileWriteDetail,
      input: {
        path: "clients/web/src/domains/chat/utils/tool-input.ts",
        content: 'export const FILE_PATH_KEYS = ["path"] as const;\n',
        old_string: "",
        new_string: "",
      },
    },
  },
};

/**
 * Both path spellings present. `path` is the one the tool reads, so it is the
 * one named here.
 */
export const BothPathSpellings: Story = {
  args: {
    ...write,
    detail: {
      ...fileWriteDetail,
      input: {
        path: "clients/web/src/executed.ts",
        file_path: "clients/web/src/ignored.ts",
        content: "const a = 1;\n",
      },
    },
  },
};
