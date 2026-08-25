/**
 * The two states the Share Feedback dialog shows before it exists: the
 * skeleton drawn while its chunk is in flight, and the failure drawn when the
 * chunk never arrives.
 *
 * Both render the design library modal, which is what gives each one a focus
 * trap, escape-to-dismiss, and dialog semantics while it stands in for a
 * dialog that is not there yet.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import { ShareFeedbackModalFallback } from "@/components/share-feedback-modal-fallback";
import { ShareFeedbackModalLoadError } from "@/components/share-feedback-modal-load-error";

const meta: Meta<typeof ShareFeedbackModalFallback> = {
  title: "Loading States/Share Feedback Modal",
  component: ShareFeedbackModalFallback,
  parameters: { layout: "fullscreen" },
};

export default meta;

/** What a tap on "Share Feedback" paints while the chunk is in flight. */
export const Loading: StoryObj<typeof ShareFeedbackModalFallback> = {
  args: { onClose: () => {} },
};

/** The chunk never arrived. Retry re-imports; Close drops the dialog. */
export const LoadFailed: StoryObj<typeof ShareFeedbackModalLoadError> = {
  render: () => (
    <ShareFeedbackModalLoadError onRetry={() => {}} onClose={() => {}} />
  ),
};
