import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState, type ReactNode } from "react";

import { CompanionTourEntryModal } from "@/components/companion-tour-entry";

function TourAnnouncementStory(): ReactNode {
  const [open, setOpen] = useState(true);
  return (
    <div className="h-screen min-h-[620px] bg-[var(--surface-base)]">
      <CompanionTourEntryModal
        open={open}
        onStart={() => setOpen(false)}
        onDismiss={() => setOpen(false)}
      />
    </div>
  );
}

const meta: Meta<typeof TourAnnouncementStory> = {
  title: "Companion/Tour announcement",
  component: TourAnnouncementStory,
  parameters: { layout: "fullscreen", controls: { disable: true } },
};

export default meta;
type Story = StoryObj<typeof TourAnnouncementStory>;

export const BeforeTheTour: Story = {};
