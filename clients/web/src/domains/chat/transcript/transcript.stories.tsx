import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import type { Meta, StoryObj } from "@storybook/react-vite";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { useTurnStore } from "@/domains/chat/turn-store";
import type { DisplayMessage } from "@/domains/chat/types/types";

import { Transcript, type TranscriptHandle, type TranscriptProps } from "./transcript";
import type { MessageItem, TranscriptItem } from "./types";

// ---------------------------------------------------------------------------
// Fixtures
//
// `Transcript` takes a flat `TranscriptItem[]`. A text row is a `MessageItem`
// wrapping a `DisplayMessage` whose body is three positional arrays kept in
// lockstep — `textSegments`, `contentOrder`, `contentBlocks` — exactly the
// shape the ingest boundary materializes for a single text block (the canonical
// builder is `textBody` in `utils/message-test-helpers.ts`). `message()` is the
// thin local builder for that shape; `user`/`assistant` name the role.
// ---------------------------------------------------------------------------

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
): MessageItem {
  const msg: DisplayMessage = {
    id,
    role,
    textSegments: [text],
    contentOrder: [{ type: "text", id: "0" }],
    contentBlocks: [{ type: "text", text }],
  };
  return { kind: "message", key: id, message: msg };
}
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

/** A sized chat surface; `Transcript` fills its `h-full` parent. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        height: 720,
        width: 780,
        overflow: "hidden",
        borderRadius: 12,
        border: "1px solid var(--border-base)",
        background: "var(--surface-base)",
      }}
    >
      {children}
    </div>
  );
}

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
    (Story) => (
      <Frame>
        <Story />
      </Frame>
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
