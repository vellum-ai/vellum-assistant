import type { Meta, StoryObj } from "@storybook/react-vite";

import { DetailPanelStoryFrame } from "@/domains/chat/components/detail-panel-story-frame";
import {
  bashDeniedDetail,
  bashDetail,
  bashErrorDetail,
  bashStreamingDetail,
} from "@/domains/chat/components/tool-detail-story-fixtures";

import { BashDetail } from "./bash-detail";

/**
 * The body for `bash` and `host_bash`: the command, then what it printed.
 *
 * It owns its Output section rather than leaving it to the generic one, which
 * means it also owns every reason the section can be empty. Those are the
 * states worth looking at here, since an empty block that says the wrong thing
 * about *why* it is empty is the failure this renderer can produce: a declined
 * call must never read as one that ran and returned nothing.
 */
const meta = {
  title: "Chat/ToolActivity/BashDetail",
  component: BashDetail,
  decorators: [
    (Story) => (
      <DetailPanelStoryFrame>
        <div className="p-5">
          <Story />
        </div>
      </DetailPanelStoryFrame>
    ),
  ],
} satisfies Meta<typeof BashDetail>;

export default meta;
type Story = StoryObj<typeof BashDetail>;

const base = {
  streamedOutput: undefined,
  isRunning: false,
  isError: false,
  isDenied: false,
  assistantId: "assistant-1",
};

/** A command that ran and printed something. */
export const Completed: Story = {
  args: { ...base, detail: bashDetail, result: bashDetail.result },
};

/** Still running, with the live stdout tail standing in for the result. */
export const Streaming: Story = {
  args: {
    ...base,
    detail: bashStreamingDetail,
    result: undefined,
    streamedOutput: bashStreamingDetail.streamedOutput,
    isRunning: true,
  },
};

/** A non-zero exit: the output is tinted so a failure reads as one. */
export const Errored: Story = {
  args: {
    ...base,
    detail: bashErrorDetail,
    result: bashErrorDetail.result,
    isError: true,
  },
};

/**
 * Declined at the confirmation. The command still shows, because what was
 * asked for is the whole point of the record, and the Output section says the
 * call was not approved rather than that it returned nothing.
 */
export const Denied: Story = {
  args: {
    ...base,
    detail: bashDeniedDetail,
    result: undefined,
    isDenied: true,
  },
};

/** Ran to completion and printed nothing, which is a result, not an absence. */
export const EmptyOutput: Story = {
  args: { ...base, detail: bashDetail, result: "" },
};

/**
 * The legacy `cmd` spelling, which persisted calls still carry. Reading only
 * `command` would leave the command blank on those conversations.
 */
export const LegacyCommandKey: Story = {
  args: {
    ...base,
    detail: { ...bashDetail, input: { cmd: "git status --short" } },
    result: "M clients/web/src/domains/chat/components/tool-detail-panel.tsx",
  },
};
