import { useEffect, useState, type ReactNode } from "react";

import type { Meta, StoryObj } from "@storybook/react-vite";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { useTurnStore } from "@/domains/chat/turn-store";
import type { DisplayMessage } from "@/domains/chat/types/types";

import { Transcript } from "./transcript";
import type { MessageItem, TranscriptItem } from "./types";

// ---------------------------------------------------------------------------
// Fixtures — mocked transcript data (the shape the ingest boundary produces:
// `textSegments` + `contentOrder` + `contentBlocks` in lockstep).
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

// A longer history so the virtualization (windowing + scroll) is exercised.
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

const meta: Meta<typeof Transcript> = {
  title: "Chat/Transcript",
  component: Transcript,
  parameters: { layout: "centered" },
  args: {
    conversationId: "demo",
    onSurfaceAction: () => {},
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
  args: { items: CONVERSATION, renderAvatar },
};

/** No messages yet — the transcript renders nothing. */
export const Empty: Story = {
  args: { items: [] },
};

/** Enough turns to overflow the viewport; only the visible window is in the
 *  DOM. Scroll up to page through history. */
export const LongHistory: Story = {
  args: { items: LONG_HISTORY, renderAvatar },
};

/**
 * The latest answer streams in over time while the turn store reports a
 * streaming phase. The user's question pins to the top of the viewport and the
 * response fills the reserved space below it (self-contained — the story drives
 * its own interval, like a real turn). Open it and watch the answer build.
 */
export const Streaming: Story = {
  render: function StreamingStory(args) {
    const [items, setItems] = useState<TranscriptItem[]>(() => [
      ...CONVERSATION,
      user("uq", "Walk me through the whole release flow, in detail."),
    ]);

    useEffect(() => {
      useTurnStore.setState({ phase: "streaming" });
      const chunks = [
        "Sure — here's the end-to-end flow.",
        "On every PR, CI runs lint, type-check, and the isolated test runner.",
        "Merging to `main` triggers the release workflow via GitHub Actions.",
        "The workflow builds the web client and the desktop app artifacts.",
        "Artifacts are uploaded and the version is tagged.",
        "Feature-flagged work stays dark until the flag is flipped on the platform.",
        "Finally, the rollout is monitored and can be reverted by toggling the flag.",
      ];
      let i = 0;
      const id = setInterval(() => {
        if (i >= chunks.length) {
          clearInterval(id);
          useTurnStore.setState({ phase: "idle" });
          return;
        }
        setItems((prev) => [...prev, assistant(`s${i}`, chunks[i] ?? "")]);
        i += 1;
      }, 1300);
      return () => {
        clearInterval(id);
        useTurnStore.setState({ phase: "idle" });
      };
    }, []);

    return <Transcript {...args} items={items} renderAvatar={renderAvatar} />;
  },
};
