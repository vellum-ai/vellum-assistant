import { type ReactNode, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { TranscriptColumn } from "./transcript-column";
import { TranscriptRow } from "./transcript-row";
import {
  SessionGroupRow,
  type SessionGroupMode,
  type SessionGroupRowProps,
} from "./session-group-row";
import { defaultSessionGroupOpen } from "./session-group-summary";
import { cameraFrame, message } from "./transcript-story-fixtures";
import type { TranscriptItem } from "./types";

const STARTED_AT = Date.UTC(2026, 8, 15, 14, 0);
const ENDED_AT = STARTED_AT + 125_000;
const noop = () => {};

const TEXT_ITEMS: TranscriptItem[] = [
  message("session-user", "user", "Open my calendar and move the appointment."),
  message(
    "session-assistant",
    "assistant",
    "I opened the calendar and moved the appointment to 3:30 PM.",
  ),
  message("session-user-follow-up", "user", "Add a 30 minute reminder too."),
  message(
    "session-assistant-follow-up",
    "assistant",
    "Done. The event now has a 30 minute reminder.",
  ),
];

const FRAME_ITEMS: TranscriptItem[] = [
  {
    kind: "message",
    key: "frame-one",
    message: cameraFrame("frame-one", {
      timestamp: STARTED_AT + 10_000,
      previewUrl:
        "data:image/svg+xml;utf8," +
        encodeURIComponent(
          "<svg xmlns='http://www.w3.org/2000/svg' width='320' height='180'><rect width='320' height='180' fill='#dce8dd'/><circle cx='190' cy='84' r='54' fill='#6f9e78'/></svg>",
        ),
    }),
  },
  {
    kind: "message",
    key: "frame-two",
    message: cameraFrame("frame-two", {
      timestamp: STARTED_AT + 25_000,
      previewUrl:
        "data:image/svg+xml;utf8," +
        encodeURIComponent(
          "<svg xmlns='http://www.w3.org/2000/svg' width='320' height='180'><rect width='320' height='180' fill='#efe7d4'/><circle cx='122' cy='92' r='48' fill='#b09a5f'/></svg>",
        ),
    }),
  },
];

function SessionChildren({ items = TEXT_ITEMS }: { items?: TranscriptItem[] }) {
  return items.map((item) => (
    <TranscriptRow
      key={item.key}
      item={item}
      conversationId="session-group-story"
      onSurfaceAction={noop}
    />
  ));
}

function StoryFrame({ children }: { children: ReactNode }) {
  return (
    <div className="h-[720px] w-[min(780px,100vw)] overflow-y-auto rounded-[var(--radius-xl)] border border-[var(--border-base)] bg-[var(--surface-base)] py-8">
      <TranscriptColumn>{children}</TranscriptColumn>
    </div>
  );
}

function ControlledStory({
  mode,
  summary,
  initiallyObservedLive = false,
  children = <SessionChildren />,
}: {
  mode: SessionGroupMode;
  summary: SessionGroupRowProps["summary"];
  initiallyObservedLive?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(() =>
    defaultSessionGroupOpen(initiallyObservedLive),
  );
  return (
    <StoryFrame>
      <SessionGroupRow
        mode={mode}
        summary={summary}
        open={open}
        onOpenChange={setOpen}
      >
        {children}
      </SessionGroupRow>
    </StoryFrame>
  );
}

const meta: Meta<typeof SessionGroupRow> = {
  title: "Chat/SessionGroupRow",
  component: SessionGroupRow,
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof SessionGroupRow>;

export const ComputerUseCollapsed: Story = {
  render: () => (
    <ControlledStory
      mode="computerUse"
      summary={{ state: "completed", startedAt: STARTED_AT, endedAt: ENDED_AT }}
    />
  ),
};

export const ComputerUseExpanded: Story = {
  render: () => (
    <ControlledStory
      mode="computerUse"
      summary={{ state: "completed", startedAt: STARTED_AT, endedAt: ENDED_AT }}
      initiallyObservedLive
    />
  ),
};

export const BrowserWaitingDark: Story = {
  globals: { theme: "dark" },
  render: () => (
    <ControlledStory
      mode="browser"
      summary={{ state: "waiting", startedAt: STARTED_AT, now: ENDED_AT }}
      initiallyObservedLive
    />
  ),
};

export const LiveVisionFinishingVelvet: Story = {
  globals: { theme: "velvet" },
  render: () => (
    <ControlledStory
      mode="liveVision"
      summary={{ state: "finishing", startedAt: STARTED_AT, now: ENDED_AT }}
      initiallyObservedLive
    >
      <SessionChildren items={FRAME_ITEMS} />
    </ControlledStory>
  ),
};

export const AmbientUnavailable: Story = {
  render: () => (
    <ControlledStory mode="ambient" summary={{ state: "unavailable" }} />
  ),
};

export const InterruptedUnknownEnd: Story = {
  render: () => (
    <ControlledStory
      mode="browser"
      summary={{
        state: "interrupted",
        startedAt: STARTED_AT,
        lastActivityAt: ENDED_AT,
      }}
    />
  ),
};

export const FramesOnlyBoundary: Story = {
  render: () => (
    <ControlledStory
      mode="liveVision"
      summary={{
        state: "settledSegment",
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
      }}
      initiallyObservedLive
    >
      <SessionChildren items={FRAME_ITEMS} />
    </ControlledStory>
  ),
};

export const MobileComputerUse: Story = {
  globals: {
    viewport: { value: "sbMobile", isRotated: false },
  },
  parameters: { layout: "fullscreen" },
  render: () => (
    <ControlledStory
      mode="computerUse"
      summary={{ state: "working", startedAt: STARTED_AT, now: ENDED_AT }}
      initiallyObservedLive
    />
  ),
};
