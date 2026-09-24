import { useLayoutEffect, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { PortalContainerProvider } from "@vellumai/design-library/utils/portal-container";

import {
  Transcript,
  type TranscriptHandle,
} from "@/domains/chat/transcript/transcript";
import { message } from "@/domains/chat/transcript/transcript-story-fixtures";
import type { TranscriptItem } from "@/domains/chat/transcript/types";

import { MobileWakeDetailOverlay } from "./mobile-wake-detail-overlay";

/** A workflow's completion hint, in the shape the daemon writes it. */
const WORKFLOW_HINT = [
  '[workflow "Summarise the release notes" completed]',
  "Run 7c1e0b52-3f1a-4a8e-9d6b-2f4e8a1c9b30 finished with status: completed.",
  "Agents spawned: 2. Tokens: 4210 in / 1180 out.",
  'Result: {"summary":"Three fixes and one new setting in this release.","items":4}',
].join("\n");

/**
 * The wake detail as a phone opens it, over the conversation it belongs to.
 * The conversation stays in view above the sheet, which is the point of
 * presenting it as a sheet rather than a screen of its own.
 */
function MobileWakeDetailStory() {
  const transcript = useRef<TranscriptHandle>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(true);
  const items: TranscriptItem[] = Array.from({ length: 10 }, (_, index) =>
    message(
      `history-${index}`,
      index % 2 === 0 ? "user" : "assistant",
      "Keep an eye on the release workflow and tell me when it finishes.",
    ),
  );

  useLayoutEffect(() => {
    transcript.current?.scrollToLatest({ behavior: "auto" });
  }, []);

  return (
    <>
      <div
        data-slot="chat-body"
        tabIndex={-1}
        className="h-dvh bg-[var(--surface-base)]"
      >
        <Transcript
          ref={transcript}
          items={items}
          conversationId="wake-sheet-example"
          onSurfaceAction={() => {}}
        />
      </div>
      <div ref={setHost} />
      <PortalContainerProvider container={host}>
        <MobileWakeDetailOverlay
          payload={
            open
              ? {
                  title: "Workflow finished",
                  body: WORKFLOW_HINT,
                  metadata: [{ label: "Source", value: "workflow_completed" }],
                }
              : null
          }
          onClose={() => setOpen(false)}
        />
      </PortalContainerProvider>
    </>
  );
}

const meta: Meta<typeof MobileWakeDetailStory> = {
  title: "Chat/MobileWakeDetailOverlay",
  component: MobileWakeDetailStory,
  parameters: { layout: "fullscreen" },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};

export default meta;
type Story = StoryObj<typeof MobileWakeDetailStory>;

export const Open: Story = {};
