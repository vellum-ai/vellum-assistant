import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { Meta, StoryObj } from "@storybook/react-vite";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { useTurnStore } from "@/domains/chat/turn-store";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type {
  ModeSessionDescriptor,
  ModeSession,
} from "@vellumai/assistant-api";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

import {
  Transcript,
  type TranscriptHandle,
  type TranscriptProps,
} from "./transcript";
import { cameraFrame, message } from "./transcript-story-fixtures";
import { TranscriptStoryFrame } from "./transcript-story-frame";
import type { TranscriptItem } from "./types";
import { useSessionDisclosureState } from "./use-session-disclosure-state";

// ---------------------------------------------------------------------------
// Fixtures
//
// `Transcript` takes a flat `TranscriptItem[]`. A text row is a `MessageItem`
// wrapping a `DisplayMessage` whose body is the single-text-block shape the
// ingest boundary materializes; `message()` in `transcript-story-fixtures.ts`
// builds that row for every transcript story file, and `user`/`assistant`
// name the role.
// ---------------------------------------------------------------------------

const user = (id: string, text: string) => message(id, "user", text);
const assistant = (id: string, text: string) => message(id, "assistant", text);

const CONVERSATION: TranscriptItem[] = [
  user("u1", "How do I set up the project locally?"),
  assistant(
    "a1",
    "Clone the repo, run `bun install`, then `bun run dev`. The web client lives in `clients/web` and proxies API calls to the local gateway.",
  ),
  user("u2", "What runs in CI on a pull request?"),
  assistant(
    "a2",
    "Three required checks: **Lint**, **Type Check**, and the isolated **Test** runner. Each test file runs in its own subprocess so `mock.module` can't leak between files.",
  ),
  user("u3", "How do feature flags work here?"),
  assistant(
    "a3",
    "Flags live in `meta/feature-flags/feature-flag-registry.json` with a matching kebab-case `id` and `key`. A gate function delegates to the resolver; undeclared flags fail closed.",
  ),
];

// Enough turns to overflow the viewport so the transcript scrolls.
const LONG_HISTORY: TranscriptItem[] = Array.from({ length: 24 }, (_, i) => [
  user(`lu${i}`, `Question ${i + 1}: can you explain part ${i + 1}?`),
  assistant(
    `la${i}`,
    `Answer ${i + 1}. ${"Here is a paragraph that wraps over a couple of lines to give the row some height. ".repeat(2)}`,
  ),
]).flat();

// A simple gradient avatar via the real ChatAvatar (production mounts one at
// the bottom of the latest turn through `renderAvatar`).
const AVATAR_URL =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='56' height='56'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='%237c5cff'/><stop offset='1' stop-color='%23e83f5b'/></linearGradient></defs><rect width='56' height='56' rx='28' fill='url(%23g)'/></svg>`,
  );
const renderAvatar = () => (
  <ChatAvatar
    components={null}
    traits={null}
    customImageUrl={AVATAR_URL}
    size={48}
  />
);

/** Renders the transcript scrolled to the latest message on mount — the resting
 *  state production lands in when a conversation opens. Isolated from the parent
 *  scroll coordinator, the bare component would otherwise open at the top. */
function TranscriptAtLatest(props: TranscriptProps) {
  const ref = useRef<TranscriptHandle>(null);
  useLayoutEffect(() => {
    ref.current?.scrollToLatest({ behavior: "auto" });
  }, []);
  return <Transcript ref={ref} {...props} />;
}

const meta: Meta<typeof Transcript> = {
  title: "Chat/Transcript",
  component: Transcript,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "The scrollable chat transcript. It renders a flat `TranscriptItem[]` " +
          "as a column (oldest first, latest at the bottom) and pins the most " +
          "recent user message to the top of the viewport while its answer " +
          "streams into the space below.",
      },
    },
  },
  args: {
    conversationId: "demo",
    onSurfaceAction: () => {},
    renderAvatar,
  },
  decorators: [
    (Story, context) => (
      <TranscriptStoryFrame width={context.parameters.transcriptWidth}>
        <Story />
      </TranscriptStoryFrame>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof Transcript>;

/** A settled conversation, opened at the latest message. */
export const Conversation: Story = {
  args: { items: CONVERSATION },
  render: (args) => <TranscriptAtLatest {...args} />,
};

const CAMERA_FRAMES = Array.from({ length: 5 }, (_, index) =>
  cameraFrame(`frame-${index}`, {
    timestamp: Date.UTC(2026, 0, 2, 12, 34, index * 5),
    previewUrl: index % 2 === 0 ? AVATAR_URL : undefined,
  }),
);

export const CameraFramesWithUtterance: Story = {
  args: {
    items: [
      {
        ...user("camera-question", "What is this?"),
        cameraFrames: CAMERA_FRAMES,
      },
    ],
  },
};

export const StandaloneCameraFrames: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Every saved frame remains addressable. When speech arrives, the utterance hosts the group and any open frame preview closes.",
      },
    },
  },
  args: {
    items: [
      {
        kind: "message",
        key: CAMERA_FRAMES[0]!.id,
        message: CAMERA_FRAMES[0]!,
        cameraFrames: CAMERA_FRAMES,
      },
    ],
  },
};

// Messages exercising the block-level markdown the transcript renders beyond
// plain prose — blockquote with inline code chips, a table with wrapping code
// cells, and a fenced block — so message-level rendering regressions in those
// shapes are visible in a transcript context, not just in the design library's
// isolated MarkdownMessage stories.
const RICH_CONTENT: TranscriptItem[] = [
  user("ru1", "What did the failing config look like?"),
  assistant(
    "ra1",
    [
      "The report quoted it directly:",
      "",
      "> Settings shows `backup.enabled` as `false` in config, and",
      "> `handleBackupCreate()` throws a `BadRequestError` saying creation",
      "> moved to the gateway (`POST /v1/backups/create`).",
      "",
      "The relevant keys:",
      "",
      "| Key | Value |",
      "| --- | --- |",
      "| `backup.enabled` | `false` |",
      "| `backup.localDirectory` | `null` — falls back to the workspace-adjacent default |",
      "",
      "And the fix:",
      "",
      "```ts",
      "await updateConfig({ backup: { enabled: true } });",
      "```",
    ].join("\n"),
  ),
];

/** Quote + inline code, a table, and fenced code inside real transcript rows. */
export const RichContent: Story = {
  args: { items: RICH_CONTENT },
  render: (args) => <TranscriptAtLatest {...args} />,
};

/** No messages yet — a fresh conversation renders an empty transcript. */
export const Empty: Story = {
  args: { items: [] },
};

/** A long history that overflows the viewport — opens at the latest turn;
 *  scroll up to page back through earlier ones. */
export const LongHistory: Story = {
  args: { items: LONG_HISTORY },
  render: (args) => <TranscriptAtLatest {...args} />,
};

/**
 * A live turn: the user's question pins to the top of the viewport and the
 * answer streams into the reserved space below it, one growing assistant bubble
 * — read long answers top-down, like Claude.ai. The story is self-contained: it
 * drives the turn store into its `streaming` phase (so the live row shows its
 * streaming state) and feeds the answer in word by word, returning to `idle`
 * when it finishes.
 */
export const Streaming: Story = {
  parameters: { controls: { disable: true } },
  render: function StreamingStory(args) {
    const ref = useRef<TranscriptHandle>(null);
    const [answer, setAnswer] = useState("");

    // Land the question at the viewport top once it's mounted. Its min-height
    // reserve (owned by `Transcript`) makes room below, so scrolling to the
    // latest message pins the question up and the answer streams into the
    // reserved space beneath it. rAF lets the reserve settle before we scroll.
    useLayoutEffect(() => {
      const raf = requestAnimationFrame(() =>
        ref.current?.scrollToLatest({ behavior: "auto" }),
      );
      return () => cancelAnimationFrame(raf);
    }, []);

    useEffect(() => {
      useTurnStore.setState({ phase: "streaming" });
      const full =
        "Sure — here's the end-to-end flow. On every PR, CI runs lint, " +
        "type-check, and the isolated test runner. Merging to `main` triggers " +
        "the release workflow via GitHub Actions, which builds the web client " +
        "and the desktop artifacts, uploads them, and tags the version. " +
        "Feature-flagged work stays dark until the flag is flipped on the " +
        "platform, and the rollout is reverted by toggling that same flag.";
      const words = full.split(" ");
      let count = 0;
      const id = setInterval(() => {
        count += 1;
        setAnswer(words.slice(0, count).join(" "));
        if (count >= words.length) {
          clearInterval(id);
          useTurnStore.setState({ phase: "idle" });
        }
      }, 90);
      return () => {
        clearInterval(id);
        useTurnStore.setState({ phase: "idle" });
      };
    }, []);

    const items: TranscriptItem[] = [
      ...CONVERSATION,
      user("uq", "Walk me through the whole release flow, in detail."),
      ...(answer ? [assistant("a-stream", answer)] : []),
    ];

    return <Transcript ref={ref} {...args} items={items} />;
  },
};

const SESSION_NOW = Date.UTC(2026, 8, 15, 14, 5);
const COMPLETED_SESSION_ID = "browser-session-recorded";
const ACTIVE_SESSION_ID = "computer-session-live";
const LIVE_SESSION_ID = "live-vision-session";

function withSession(
  item: TranscriptItem,
  modeSession: ModeSession,
  timestamp: number,
): TranscriptItem {
  if (item.kind !== "message") {
    return item;
  }
  const message: DisplayMessage = {
    ...item.message,
    timestamp,
    modeSession,
    modeSessionActivity: { firstAt: timestamp, lastAt: timestamp },
  };
  const cameraFrames = item.cameraFrames?.map((frame) => {
    const frameTimestamp = frame.timestamp ?? timestamp;
    return {
      ...frame,
      modeSession,
      modeSessionActivity: {
        firstAt: frameTimestamp,
        lastAt: frameTimestamp,
      },
    };
  });
  return { ...item, message, cameraFrames };
}

const SESSION_ITEMS: TranscriptItem[] = [
  user(
    "session-request",
    "Open the release dashboard and check the latest run.",
  ),
  withSession(
    assistant(
      "session-recorded-1",
      "I opened the dashboard and inspected the latest workflow.",
    ),
    { mode: "browser", id: COMPLETED_SESSION_ID },
    SESSION_NOW - 300_000,
  ),
  withSession(
    assistant(
      "session-recorded-2",
      "The workflow completed successfully and all required jobs passed.",
    ),
    { mode: "browser", id: COMPLETED_SESSION_ID },
    SESSION_NOW - 240_000,
  ),
  {
    kind: "surface",
    key: "session-learned-skill",
    surface: {
      surfaceId: "session-learned-skill",
      surfaceType: "skill_card",
      display: "inline",
      data: {
        skills: [
          {
            skillId: "release-status-check",
            name: "Release Status Check",
            description: "Check the latest workflow on the release dashboard.",
          },
        ],
      },
    },
  },
  user("session-latest-request", "Please capture the final artifact details."),
  withSession(
    assistant(
      "session-live-response",
      "I am opening the artifact list and checking the signed packages.",
    ),
    { mode: "computer_use", id: ACTIVE_SESSION_ID },
    SESSION_NOW - 30_000,
  ),
  {
    kind: "surface",
    key: "session-artifact-choice",
    surface: {
      surfaceId: "session-artifact-choice",
      surfaceType: "choice",
      title: "Which package should I inspect?",
      display: "inline",
      data: {
        options: [
          { id: "desktop", title: "Desktop package" },
          { id: "mobile", title: "Mobile package" },
        ],
      },
    },
  },
];

const SESSION_DESCRIPTORS: ModeSessionDescriptor[] = [
  {
    summary: {
      id: COMPLETED_SESSION_ID,
      conversationId: "session-story",
      mode: "browser",
      sourceStartedAt: SESSION_NOW - 330_000,
      firstIncludedAt: SESSION_NOW - 300_000,
      firstIncludedMessageId: "session-recorded-1",
      lastActivityAt: SESSION_NOW - 240_000,
      lastOwnedMessageId: "session-recorded-2",
      revision: 2,
      status: "completed",
      endedAt: SESSION_NOW - 235_000,
      endReason: "completed",
    },
  },
  {
    summary: {
      id: ACTIVE_SESSION_ID,
      conversationId: "session-story",
      mode: "computer_use",
      sourceStartedAt: SESSION_NOW - 45_000,
      firstIncludedAt: SESSION_NOW - 30_000,
      firstIncludedMessageId: "session-live-response",
      lastActivityAt: SESSION_NOW - 15_000,
      lastOwnedMessageId: "session-live-response",
      revision: 1,
      status: "active",
      endedAt: null,
      endReason: null,
    },
    runtimeState: "waiting",
  },
];

function setSessionGroupsStoryFlag(enabled: boolean) {
  useAssistantFeatureFlagStore.setState({ sessionGroups: enabled });
  return () => {
    useAssistantFeatureFlagStore.setState({ sessionGroups: false });
  };
}

function SessionGroupingStory() {
  const sessionGroupsEnabled = useAssistantFeatureFlagStore.use.sessionGroups();
  const disclosure = useSessionDisclosureState(
    "session-story",
    sessionGroupsEnabled,
  );
  const { observeLiveSession } = disclosure;
  useEffect(() => {
    observeLiveSession(ACTIVE_SESSION_ID);
  }, [observeLiveSession]);

  return (
    <TranscriptAtLatest
      items={SESSION_ITEMS}
      conversationId="session-story"
      modeSessionDescriptors={SESSION_DESCRIPTORS}
      sessionDisclosureState={disclosure}
      sessionClockConnected
      sessionClockNow={SESSION_NOW}
      onSurfaceAction={() => {}}
      renderAvatar={renderAvatar}
    />
  );
}

/** Recorded history is closed while the session observed live in this visit is open. */
export const SessionHistoryAndLatestTurn: Story = {
  beforeEach: () => setSessionGroupsStoryFlag(true),
  parameters: { controls: { disable: true } },
  render: () => <SessionGroupingStory />,
};

/** The same canonical rows remain flat when the presentation flag is disabled. */
export const SessionGroupingFlagOff: Story = {
  beforeEach: () => setSessionGroupsStoryFlag(false),
  parameters: { controls: { disable: true } },
  render: () => <SessionGroupingStory />,
};

const ADJACENT_SESSION_ITEMS = SESSION_ITEMS.filter(
  (item) => item.kind === "message" && item.key !== "session-latest-request",
);

export const AdjacentSessionGroups: Story = {
  args: {
    items: ADJACENT_SESSION_ITEMS,
    conversationId: "session-story",
    modeSessionDescriptors: SESSION_DESCRIPTORS,
    sessionGroupsEnabled: true,
    sessionClockNow: SESSION_NOW,
  },
};

export const AdjacentSessionGroupsInHistory: Story = {
  args: {
    ...AdjacentSessionGroups.args,
    items: [
      ...ADJACENT_SESSION_ITEMS,
      user("next-request", "Thanks. What should I check next?"),
    ],
  },
};

/** The composed session transcript fits the real mobile viewport width. */
export const SessionHistoryAndLatestTurnMobile: Story = {
  beforeEach: () => setSessionGroupsStoryFlag(true),
  globals: { viewport: { value: "sbMobile", isRotated: false } },
  parameters: {
    controls: { disable: true },
    transcriptWidth: "100%",
  },
  render: () => <SessionGroupingStory />,
};

const REPEATED_SESSION_RUNS = [
  {
    mode: "browser",
    request: "Find a lightweight laptop under $1,200.",
    thinking: "I will compare price and weight across the available models.",
    activity: "Checking laptop specifications",
    response:
      "I found two options under budget: a 13-inch model at $999 and a 14-inch model at $1,149.",
    duration: 42_000,
  },
  {
    mode: "browser",
    request: "Compare the two best options.",
    thinking: "I will check battery life and ports before recommending one.",
    activity: "Comparing battery life and ports",
    response:
      "The 13-inch model is lighter. The 14-inch model has more ports and a larger battery.",
    duration: 60_000,
  },
  {
    mode: "computer_use",
    request: "Put the comparison in a spreadsheet.",
    thinking:
      "I will enter price, weight, battery life, and ports in separate columns.",
    activity: "Entering the laptop comparison",
    response:
      "The comparison is in the spreadsheet, with one row for each laptop.",
    duration: 18_000,
  },
] as const;

const REPEATED_SESSION_ITEMS: TranscriptItem[] = [];
const REPEATED_SESSION_DESCRIPTORS: ModeSessionDescriptor[] = [];
for (const [index, run] of REPEATED_SESSION_RUNS.entries()) {
  const id = `compact-session-${index}`;
  const responseId = `${id}-response`;
  const startedAt = SESSION_NOW - (3 - index) * 120_000;
  const endedAt = startedAt + run.duration;
  const toolCall: ChatMessageToolCall = {
    id: `${id}-tool`,
    name: run.mode === "browser" ? "bash" : "computer_use_type_text",
    input:
      run.mode === "browser"
        ? { command: "assistant browser snapshot", activity: run.activity }
        : {
            text: "Model\tPrice\tWeight\tBattery life\tPorts",
            reasoning: run.activity,
          },
    startedAt,
    completedAt: endedAt,
  };
  const response: TranscriptItem = {
    kind: "message",
    key: responseId,
    message: {
      id: responseId,
      role: "assistant",
      contentBlocks: [
        { type: "thinking", thinking: run.thinking },
        { type: "tool_use", toolCall },
        { type: "text", text: run.response },
      ],
      toolCalls: [toolCall],
    },
  };
  const request = user(`${id}-request`, run.request);
  request.message.timestamp = startedAt - 1_000;
  REPEATED_SESSION_ITEMS.push(
    request,
    withSession(response, { mode: run.mode, id }, startedAt),
  );
  REPEATED_SESSION_DESCRIPTORS.push({
    summary: {
      id,
      conversationId: "compact-session-story",
      mode: run.mode,
      sourceStartedAt: startedAt,
      firstIncludedAt: startedAt,
      firstIncludedMessageId: responseId,
      lastActivityAt: endedAt,
      lastOwnedMessageId: responseId,
      revision: 2,
      status: "completed",
      endedAt,
      endReason: "completed",
    },
  });
}

export const RepeatedBrowserAndComputerSessions: Story = {
  globals: { theme: "dark" },
  beforeEach: () => setSessionGroupsStoryFlag(true),
  args: {
    items: REPEATED_SESSION_ITEMS,
    conversationId: "compact-session-story",
    modeSessionDescriptors: REPEATED_SESSION_DESCRIPTORS,
    sessionGroupsEnabled: true,
    sessionClockNow: SESSION_NOW,
  },
};

export const RepeatedBrowserAndComputerSessionsMobile: Story = {
  ...RepeatedBrowserAndComputerSessions,
  globals: {
    theme: "dark",
    viewport: { value: "sbMobile", isRotated: false },
  },
  parameters: { transcriptWidth: "100%" },
};

const LIVE_ITEMS: TranscriptItem[] = [
  withSession(
    {
      ...user(
        "live-request",
        "Can you identify the item in front of the camera?",
      ),
      cameraFrames: [
        cameraFrame("live-frame", {
          timestamp: SESSION_NOW - 20_000,
          previewUrl: AVATAR_URL,
        }),
      ],
    },
    { mode: "live_vision", id: LIVE_SESSION_ID },
    SESSION_NOW - 20_000,
  ),
  withSession(
    assistant(
      "live-response",
      "It appears to be a small notebook with a green fabric cover.",
    ),
    { mode: "live_vision", id: LIVE_SESSION_ID },
    SESSION_NOW - 5_000,
  ),
];

const LIVE_DESCRIPTOR: ModeSessionDescriptor = {
  summary: {
    id: LIVE_SESSION_ID,
    conversationId: "live-session-story",
    mode: "live_vision",
    sourceStartedAt: SESSION_NOW - 25_000,
    firstIncludedAt: SESSION_NOW - 20_000,
    firstIncludedMessageId: "live-request",
    lastActivityAt: SESSION_NOW - 5_000,
    lastOwnedMessageId: "live-response",
    revision: 1,
    status: "active",
    endedAt: null,
    endReason: null,
  },
};

function LiveSessionStory() {
  const sessionGroupsEnabled = useAssistantFeatureFlagStore.use.sessionGroups();
  const disclosure = useSessionDisclosureState(
    "live-session-story",
    sessionGroupsEnabled,
  );
  const { observeLiveSession } = disclosure;
  useEffect(() => {
    observeLiveSession(LIVE_SESSION_ID);
  }, [observeLiveSession]);

  return (
    <TranscriptAtLatest
      items={LIVE_ITEMS}
      conversationId="live-session-story"
      modeSessionDescriptors={[LIVE_DESCRIPTOR]}
      sessionDisclosureState={disclosure}
      sessionClockConnected
      sessionClockNow={SESSION_NOW}
      onSurfaceAction={() => {}}
      renderAvatar={renderAvatar}
    />
  );
}

/** Live vision includes its stamped camera/user prefix in the active group. */
export const LiveSessionLatestTurn: Story = {
  beforeEach: () => setSessionGroupsStoryFlag(true),
  parameters: { controls: { disable: true } },
  render: () => <LiveSessionStory />,
};

export const LiveSessionLatestTurnMobile: Story = {
  ...LiveSessionLatestTurn,
  globals: {
    theme: "dark",
    viewport: { value: "sbMobile", isRotated: false },
  },
  parameters: { controls: { disable: true }, transcriptWidth: "100%" },
};
