/**
 * The two states the Share Feedback dialog shows before it exists.
 *
 * Both render the dialog's own shell (`share-feedback-modal-shell.ts`), so the
 * placeholder and the failure land exactly where the real dialog will. The
 * previous behaviour was a `null` Suspense fallback plus `LazyBoundary`'s
 * inline paragraph, neither of which the user could see.
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
