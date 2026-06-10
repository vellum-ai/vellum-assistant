import { getRenderFromContentBlocks } from "@/lib/backwards-compat/content-blocks-render-flag";
import { TranscriptMessageBodyFromBlocks } from "@/domains/chat/transcript/transcript-message-body-from-blocks";
import { TranscriptMessageBodyLegacy } from "@/domains/chat/transcript/transcript-message-body-legacy";
import type { TranscriptMessageBodyProps } from "@/domains/chat/transcript/transcript-message-body-shared";

/**
 * Single render seam. `renderFromContentBlocks` is read once here so the whole
 * row commits to one source of truth: the blocks-driven walk
 * (`TranscriptMessageBodyFromBlocks`) or the legacy positional walk
 * (`TranscriptMessageBodyLegacy`). The two are independent React trees with no
 * per-read `block ?? positional` fallback — flipping the flag is an
 * apples-to-apples switch for QA, and retiring the positional arrays later is a
 * matter of deleting the legacy body and this branch.
 */
export function TranscriptMessageBody(props: TranscriptMessageBodyProps) {
  if (getRenderFromContentBlocks()) {
    return <TranscriptMessageBodyFromBlocks {...props} />;
  }
  return <TranscriptMessageBodyLegacy {...props} />;
}
