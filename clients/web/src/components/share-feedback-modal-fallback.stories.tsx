/**
 * The two states the Share Feedback dialog shows before it exists: the
 * skeleton drawn while its chunk is in flight, and the failure drawn when the
 * chunk never arrives.
 *
 * The skeleton renders the dialog's own shell (`share-feedback-modal-shell.ts`)
 * so it lands exactly where the real dialog will. The failure renders the
 * design library modal, which is what gives it a focus trap and dismissal.
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
export const Loading: StoryObj<typeof ShareFeedbackModalFallback> = {};

/** The chunk never arrived. Retry re-imports; Close drops the dialog. */
export const LoadFailed: StoryObj<typeof ShareFeedbackModalLoadError> = {
  render: () => (
    <ShareFeedbackModalLoadError onRetry={() => {}} onClose={() => {}} />
  ),
};
