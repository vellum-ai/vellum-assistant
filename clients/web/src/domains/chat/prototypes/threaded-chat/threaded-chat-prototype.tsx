/**
 * Interactive prototype of a Slack-DM-style chat: one main conversation, and
 * a reply to any message opens a thread (a child conversation) without a
 * sidebar of top-level chats.
 *
 * Everything visual is driven by {@link ThreadedChatOptions} so the Storybook
 * Controls panel can be used to tune the design. State (what was sent, which
 * thread is open) lives in the component and is not persisted.
 *
 * This is a design prototype, not product code: the composer, rail, and
 * message rows are prototype-local and intentionally simpler than the
 * shipped ones.
 */

/* eslint-disable local/no-untranslated-strings -- design prototype rendered
   only in Storybook; its copy is fixture text, not shipped UI. */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowLeft,
  ArrowUp,
  Bookmark,
  ChevronRight,
  Copy,
  Home,
  MessagesSquare,
  Plus,
  Reply,
  Search,
  Settings,
  SmilePlus,
  X,
} from "lucide-react";

import { Button, MarkdownMessage, Tooltip } from "@vellumai/design-library";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { AnimatedRightDrawer } from "@/domains/chat/components/animated-right-drawer";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { cn } from "@/utils/misc";

import {
  ASSISTANT_IN_THREAD_SEED,
  MOCK_REPLIES,
  PROTO_ASSISTANT_NAME,
  PROTO_NOW,
  PROTO_USER_NAME,
  SEED_STATE,
  type ProtoAuthor,
  type ProtoMessage,
  type ProtoState,
  type ProtoThread,
} from "./fixtures";

// ---------------------------------------------------------------------------
// Options (the Storybook knobs)
// ---------------------------------------------------------------------------

/** Where a thread opens when the user enters it from the main conversation. */
export type ThreadPresentation =
  /** Slack: a resizable right-hand panel beside the main conversation. */
  | "side-panel"
  /** The thread expands in place under its parent message. */
  | "inline"
  /** The thread replaces the main column, with a back affordance. */
  | "drill-in"
  /** The thread floats over a dimmed main conversation. */
  | "overlay";

/** How message rows are drawn. */
export type MessageStyle =
  /** Shipped look: user text in a right-aligned bubble, assistant text plain. */
  | "bubbles"
  /** Slack: every message left-aligned with avatar, name, and time. */
  | "linear"
  /** Linear layout, but user rows sit on a tinted band. */
  | "hybrid";

export type ThreadIndicatorStyle =
  /** Avatar stack, reply count, and last-reply time in a pill. */
  | "pill"
  /** A thread line from the avatar down to a reply-count link. */
  | "line"
  /** A bare reply-count link. */
  | "minimal";

export type LeftRail = "none" | "icons" | "labeled";

export type ParentInThread = "quoted" | "full" | "hidden";

export interface ThreadedChatOptions {
  threadPresentation: ThreadPresentation;
  messageStyle: MessageStyle;
  density: "comfortable" | "compact";
  threadIndicator: ThreadIndicatorStyle;
  /** Whether the reply affordance shows only on hover or always. */
  replyAffordance: "hover" | "always";
  showAvatars: boolean;
  showTimestamps: boolean;
  /** Collapse consecutive messages from one author into a run (Slack). */
  groupConsecutive: boolean;
  showDateDividers: boolean;
  leftRail: LeftRail;
  parentInThread: ParentInThread;
  composerStyle: "card" | "flat";
  /** Side-panel width in px. */
  threadPanelWidth: number;
  /** Corner radius of user bubbles and composer, in px. */
  bubbleRadius: number;
  /** Max width of the transcript column, in px. */
  maxContentWidth: number;
  /** Duration of open / close transitions, in ms. */
  animationMs: number;
  /** Draw thread lines and unread marks in the accent color. */
  accentThreads: boolean;
  /** Reply with a canned assistant message a moment after each send. */
  mockAssistantReplies: boolean;
  /**
   * Where the assistant answers a top-level message. `thread` puts every
   * answer in a thread on the user's message, so the main feed holds only
   * what the user sent. Switching this swaps the seed conversation.
   */
  assistantRepliesIn: "main" | "thread";
  /**
   * In `thread` mode, how the answer shows in the main feed under the
   * user's message. `snippet` clamps the answer to {@link previewLines};
   * `expanded-latest` shows the newest exchange in full and clamps older
   * ones; `none` leaves only the thread indicator.
   */
  replyPreview: "none" | "snippet" | "expanded-latest";
  /** Lines of the answer shown by a clamped preview. */
  previewLines: number;
  /**
   * In `thread` mode, once the assistant has answered, the main composer
   * continues that thread by default. The user backs out to a new topic
   * from the chip above the composer or with Escape.
   */
  followUpDefault: "thread" | "new-topic";
}

export const DEFAULT_THREADED_CHAT_OPTIONS: ThreadedChatOptions = {
  threadPresentation: "side-panel",
  messageStyle: "bubbles",
  density: "comfortable",
  threadIndicator: "pill",
  replyAffordance: "hover",
  showAvatars: true,
  showTimestamps: true,
  groupConsecutive: false,
  showDateDividers: true,
  leftRail: "icons",
  parentInThread: "quoted",
  composerStyle: "card",
  threadPanelWidth: 440,
  bubbleRadius: 12,
  maxContentWidth: 768,
  animationMs: 260,
  accentThreads: false,
  mockAssistantReplies: true,
  assistantRepliesIn: "main",
  replyPreview: "snippet",
  previewLines: 3,
  followUpDefault: "thread",
};

export interface ThreadedChatPrototypeProps extends ThreadedChatOptions {
  /** Parent message id of a thread to open on mount. */
  initialOpenThreadId?: string | null;
  /** Seed state override. Defaults to the fixture conversation. */
  seed?: ProtoState;
}

// ---------------------------------------------------------------------------
// Time formatting (anchored at the fixture's "now")
// ---------------------------------------------------------------------------

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function clock(at: number): string {
  return new Date(at).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

function relative(at: number, now: number): string {
  const delta = Math.max(0, now - at);
  if (delta < MIN) {
    return "just now";
  }
  if (delta < HOUR) {
    return `${Math.round(delta / MIN)}m ago`;
  }
  if (delta < DAY) {
    return `${Math.round(delta / HOUR)}h ago`;
  }
  const days = Math.round(delta / DAY);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

function dayLabel(at: number, now: number): string {
  const startOfToday = Math.floor(now / DAY) * DAY;
  if (at >= startOfToday) {
    return "Today";
  }
  if (at >= startOfToday - DAY) {
    return "Yesterday";
  }
  return new Date(at).toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function sameDay(a: number, b: number): boolean {
  return Math.floor(a / DAY) === Math.floor(b / DAY);
}

/**
 * One-line plain-text preview of a markdown body: the first prose line,
 * skipping table rows, quotes, and list markers, with emphasis stripped.
 */
function snippet(markdown: string): string {
  const lines = markdown.split("\n").map((l) => l.trim());
  const prose = lines.find((l) => l.length > 0 && !/^[|>#]/.test(l));
  const line = prose ?? lines.find((l) => l.length > 0) ?? "";
  return line
    .replace(/^[-*]\s+/, "")
    .replace(/[*`_>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type View = "main" | "threads";

interface PendingReply {
  /** `null` targets the main conversation. */
  parentMessageId: string | null;
}

let nextId = 1000;
function newId(prefix: string): string {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

function useProtoChat(
  seed: ProtoState,
  mockReplies: boolean,
  /** Answer a top-level message inside a thread on it, not in the main feed. */
  repliesInThread: boolean,
) {
  const [state, setState] = useState<ProtoState>(seed);
  const [pending, setPending] = useState<PendingReply | null>(null);
  // The thread the assistant most recently answered in, so the composer can
  // follow the exchange. Cleared by the caller once consumed.
  const [lastAnswered, setLastAnswered] = useState<string | null>(null);
  // A fixture clock that moves only when the user acts, so relative times
  // stay stable while the story is idle.
  const [now, setNow] = useState(PROTO_NOW);
  const replyIndex = useRef(0);

  const append = useCallback(
    (
      parentMessageId: string | null,
      author: ProtoAuthor,
      text: string,
    ): string => {
      const at = now + (author === "user" ? 15_000 : 30_000);
      const id = newId(parentMessageId ?? "m");
      setNow(at);
      setState((prev) => {
        const message: ProtoMessage = { id, author, text, at };
        if (parentMessageId == null) {
          return { ...prev, main: [...prev.main, message] };
        }
        const existing = prev.threads[parentMessageId];
        const thread: ProtoThread = existing
          ? { ...existing, replies: [...existing.replies, message] }
          : {
              conversationId: `thread-${parentMessageId}`,
              parentMessageId,
              replies: [message],
              unread: 0,
            };
        return {
          ...prev,
          threads: { ...prev.threads, [parentMessageId]: thread },
        };
      });
      return id;
    },
    [now],
  );

  const send = useCallback(
    (parentMessageId: string | null, text: string) => {
      const id = append(parentMessageId, "user", text);
      if (mockReplies) {
        const target =
          parentMessageId == null && repliesInThread ? id : parentMessageId;
        setPending({ parentMessageId: target });
      }
    },
    [append, mockReplies, repliesInThread],
  );

  useEffect(() => {
    if (pending == null) {
      return;
    }
    const timer = window.setTimeout(() => {
      const text = MOCK_REPLIES[replyIndex.current % MOCK_REPLIES.length];
      replyIndex.current += 1;
      append(pending.parentMessageId, "assistant", text);
      setPending(null);
      setLastAnswered(pending.parentMessageId);
    }, 1100);
    return () => window.clearTimeout(timer);
  }, [pending, append]);

  const clearLastAnswered = useCallback(() => setLastAnswered(null), []);

  const markRead = useCallback((parentMessageId: string) => {
    setState((prev) => {
      const thread = prev.threads[parentMessageId];
      if (!thread || thread.unread === 0) {
        return prev;
      }
      return {
        ...prev,
        threads: {
          ...prev.threads,
          [parentMessageId]: { ...thread, unread: 0 },
        },
      };
    });
  }, []);

  return {
    state,
    pending,
    now,
    send,
    markRead,
    lastAnswered,
    clearLastAnswered,
  };
}

// ---------------------------------------------------------------------------
// Small parts
// ---------------------------------------------------------------------------

function Avatar({ author, size }: { author: ProtoAuthor; size: number }) {
  if (author === "assistant") {
    return (
      <ChatAvatar
        components={BUNDLED_COMPONENTS}
        traits={null}
        customImageUrl={null}
        size={size}
      />
    );
  }
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-[var(--accent-purple-weak)] font-medium text-[var(--accent-purple-strong)]"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      aria-hidden
    >
      A
    </div>
  );
}

function AvatarStack({ authors, size }: { authors: ProtoAuthor[]; size: number }) {
  return (
    <div className="flex items-center">
      {authors.map((author, i) => (
        <div
          key={`${author}-${i}`}
          className="rounded-full ring-2 ring-[var(--surface-base)]"
          style={{ marginLeft: i === 0 ? 0 : -size * 0.3 }}
        >
          <Avatar author={author} size={size} />
        </div>
      ))}
    </div>
  );
}

function authorName(author: ProtoAuthor): string {
  return author === "assistant" ? PROTO_ASSISTANT_NAME : PROTO_USER_NAME;
}

function DateDivider({ label }: { label: string }) {
  return (
    <div className="my-3 flex items-center gap-3" role="separator">
      <div className="h-px flex-1 bg-[var(--border-subtle)]" />
      <span className="rounded-full border border-[var(--border-subtle)] bg-[var(--surface-base)] px-2.5 py-0.5 text-label-medium-default text-[var(--content-tertiary)]">
        {label}
      </span>
      <div className="h-px flex-1 bg-[var(--border-subtle)]" />
    </div>
  );
}

function ThinkingRow({
  options,
  compactGutter,
}: {
  options: ThreadedChatOptions;
  compactGutter: boolean;
}) {
  return (
    <div className="flex items-center gap-3 py-2">
      {options.showAvatars && !compactGutter ? (
        <Avatar author="assistant" size={options.density === "compact" ? 24 : 28} />
      ) : null}
      <div className="flex items-center gap-1" aria-label="Assistant is typing">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-1.5 animate-pulse rounded-full bg-[var(--content-tertiary)]"
            style={{ animationDelay: `${i * 160}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

interface ComposerProps {
  placeholder: string;
  onSend: (text: string) => void;
  options: ThreadedChatOptions;
  autoFocus?: boolean;
  /** Smaller chrome for the thread composer. */
  compact?: boolean;
  /**
   * The thread this composer continues, shown as a chip above the text.
   * Dismissing the chip (or pressing Escape on an empty field) returns the
   * composer to a new top-level message.
   */
  context?: { label: string; onClear: () => void } | null;
}

function Composer({
  placeholder,
  onSend,
  options,
  autoFocus,
  compact,
  context,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const text = value.trim();
    if (!text) {
      return;
    }
    onSend(text);
    setValue("");
    ref.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
    if (event.key === "Escape" && context && value.length === 0) {
      event.preventDefault();
      context.onClear();
    }
  };

  const shape: CSSProperties = {
    borderRadius: Math.max(6, options.bubbleRadius),
  };

  return (
    <div
      data-slot="proto-composer"
      className={cn(
        "flex flex-col overflow-hidden",
        options.composerStyle === "card"
          ? "bg-[var(--surface-lift)] shadow-[0px_2px_2px_rgba(0,0,0,0.05)] ring-1 ring-[var(--border-subtle)]"
          : "border border-[var(--border-element)] bg-[var(--surface-base)] focus-within:border-[var(--border-active)]",
      )}
      style={shape}
    >
      {context ? (
        <div
          data-slot="proto-composer-context"
          className="flex items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-sunken)] py-1.5 pl-3 pr-1.5 text-body-small-default text-[var(--content-secondary)]"
        >
          <Reply className="size-3.5 shrink-0 text-[var(--content-tertiary)]" />
          <span className="shrink-0 text-[var(--content-tertiary)]">
            Continuing thread
          </span>
          <span className="min-w-0 flex-1 truncate text-[var(--content-default)]">
            {context.label}
          </span>
          <Button
            variant="ghost"
            size="compact"
            onClick={context.onClear}
            className="shrink-0"
          >
            New topic
          </Button>
        </div>
      ) : null}
      <textarea
        ref={ref}
        rows={compact ? 1 : 2}
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        className={cn(
          "w-full resize-none border-none bg-transparent text-[var(--content-default)] placeholder:text-[var(--content-disabled)] focus:outline-none",
          compact ? "px-3 pt-2.5 text-body-medium-default font-normal" : "px-3.5 pt-3 text-chat",
        )}
      />
      <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-1">
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="compact"
            iconOnly={<Plus />}
            aria-label="Attach"
          />
          <Button
            variant="ghost"
            size="compact"
            iconOnly={<SmilePlus />}
            aria-label="Emoji"
          />
        </div>
        <Button
          variant="primary"
          size="compact"
          iconOnly={<ArrowUp strokeWidth={2.5} />}
          aria-label="Send"
          disabled={value.trim().length === 0}
          onClick={submit}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thread indicator (under a message that has a thread)
// ---------------------------------------------------------------------------

interface ThreadIndicatorProps {
  thread: ProtoThread;
  open: boolean;
  now: number;
  options: ThreadedChatOptions;
  onOpen: () => void;
  align: "start" | "end";
}

function ThreadIndicator({
  thread,
  open,
  now,
  options,
  onOpen,
  align,
}: ThreadIndicatorProps) {
  const count = thread.replies.length;
  const last = thread.replies[thread.replies.length - 1];
  const authors = Array.from(new Set(thread.replies.map((r) => r.author)));
  const unread = thread.unread > 0;
  const accent = options.accentThreads;
  const label = `${count} ${count === 1 ? "reply" : "replies"}`;
  const linkColor = accent
    ? "text-[var(--accent-purple-strong)]"
    : "text-[var(--content-secondary)] group-hover/thread:text-[var(--content-default)]";

  const unreadDot = unread ? (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        accent ? "bg-[var(--accent-purple-strong)]" : "bg-[var(--content-default)]",
      )}
      aria-label="Unread replies"
    />
  ) : null;

  if (options.threadIndicator === "minimal") {
    return (
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "group/thread mt-1 inline-flex items-center gap-1.5 text-body-small-default",
          align === "end" && "self-end",
          unread ? "font-medium text-[var(--content-default)]" : linkColor,
        )}
      >
        {unreadDot}
        <span>{label}</span>
        <ChevronRight className="size-3 opacity-60" />
      </button>
    );
  }

  if (options.threadIndicator === "line") {
    return (
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "group/thread mt-1.5 flex items-center gap-2 text-body-small-default",
          align === "end" && "self-end flex-row-reverse",
        )}
      >
        <span
          className={cn(
            "block h-4 w-px",
            accent ? "bg-[var(--accent-purple-strong)]" : "bg-[var(--border-element)]",
          )}
          aria-hidden
        />
        <span className={cn("flex items-center gap-1.5", unread ? "font-medium text-[var(--content-default)]" : linkColor)}>
          {unreadDot}
          {label}
          {options.showTimestamps && last ? (
            <span className="font-normal text-[var(--content-tertiary)]">
              {relative(last.at, now)}
            </span>
          ) : null}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-expanded={open}
      className={cn(
        "group/thread mt-1.5 inline-flex max-w-full items-center gap-2 rounded-lg border py-1 pl-1.5 pr-2 text-body-small-default transition-colors",
        align === "end" ? "self-end" : "self-start",
        open
          ? "border-[var(--border-element)] bg-[var(--surface-active)]"
          : "border-transparent hover:border-[var(--border-subtle)] hover:bg-[var(--surface-hover)]",
      )}
    >
      <AvatarStack authors={authors} size={20} />
      <span
        className={cn(
          "flex items-center gap-1.5",
          unread ? "font-medium text-[var(--content-default)]" : linkColor,
        )}
      >
        {unreadDot}
        {label}
      </span>
      {options.showTimestamps && last ? (
        <span className="truncate text-[var(--content-tertiary)] group-hover/thread:hidden">
          Last reply {relative(last.at, now)}
        </span>
      ) : null}
      <span className="hidden text-[var(--content-tertiary)] group-hover/thread:inline">
        View thread
      </span>
      <ChevronRight className="size-3.5 text-[var(--content-tertiary)]" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Reply preview: the assistant's threaded answer peeking into the main feed
// ---------------------------------------------------------------------------

interface ReplyPreviewProps {
  thread: ProtoThread;
  /** Show every reply unclamped instead of the first answer clamped. */
  expanded: boolean;
  open: boolean;
  now: number;
  options: ThreadedChatOptions;
  onOpen: () => void;
}

/**
 * Under a user message the assistant answered in-thread. Draws the answer the
 * way an assistant message row looks, so the main feed still reads as a
 * conversation, then a footer that names the rest of the thread. Clamped to
 * `previewLines` unless `expanded`.
 */
function ReplyPreview({
  thread,
  expanded,
  open,
  now,
  options,
  onOpen,
}: ReplyPreviewProps) {
  const compact = options.density === "compact";
  const avatarSize = compact ? 24 : 28;
  const answer = thread.replies.find((r) => r.author === "assistant");
  const shown = expanded ? thread.replies : answer ? [answer] : [];
  const rest = thread.replies.length - shown.length;
  const last = thread.replies[thread.replies.length - 1];
  const unread = thread.unread > 0;
  const accent = options.accentThreads;
  // A height clamp rather than `-webkit-line-clamp`: the answer is block
  // markdown (tables, lists, quotes), which line-clamp does not count. The
  // mask fades the cut edge so a clipped table reads as "more below".
  const lineHeight = compact ? 22 : 24;
  const clamp: CSSProperties = expanded
    ? {}
    : {
        maxHeight: options.previewLines * lineHeight,
        overflow: "hidden",
        maskImage:
          "linear-gradient(to bottom, black 55%, rgba(0, 0, 0, 0.35) 85%, transparent 100%)",
      };

  return (
    <div
      data-slot="proto-reply-preview"
      className={cn("flex w-full flex-col", compact ? "mt-1" : "mt-2")}
    >
      {shown.map((reply, i) => {
        const isUser = reply.author === "user";
        return (
          <div
            key={reply.id}
            className={cn("flex gap-3", i > 0 && (compact ? "mt-1.5" : "mt-2.5"))}
          >
            {options.showAvatars ? (
              <div className="mt-0.5 shrink-0">
                <Avatar author={reply.author} size={avatarSize} />
              </div>
            ) : null}
            <div className="min-w-0 flex-1">
              {options.showTimestamps ? (
                <div className="mb-0.5 flex items-baseline gap-2">
                  <span className="text-body-medium-default text-[var(--content-default)]">
                    {authorName(reply.author)}
                  </span>
                  <span className="text-label-medium-default text-[var(--content-tertiary)]">
                    {clock(reply.at)}
                  </span>
                </div>
              ) : null}
              <div style={clamp} className={cn(isUser && "text-[var(--content-secondary)]")}>
                <MarkdownMessage
                  content={reply.text}
                  className={cn(
                    "text-chat [&_p]:my-0 [&_table]:my-2",
                    compact && "[&_p]:leading-[22px]",
                  )}
                />
              </div>
            </div>
          </div>
        );
      })}
      <button
        type="button"
        onClick={onOpen}
        aria-expanded={open}
        className={cn(
          "group/thread mt-1.5 inline-flex items-center gap-2 self-start rounded-md py-1 pr-2 text-body-small-default transition-colors",
          options.showAvatars ? "ml-10 pl-1" : "pl-1",
          open ? "bg-[var(--surface-active)]" : "hover:bg-[var(--surface-hover)]",
          unread
            ? "font-medium text-[var(--content-default)]"
            : accent
              ? "text-[var(--accent-purple-strong)]"
              : "text-[var(--content-secondary)] hover:text-[var(--content-default)]",
        )}
      >
        {unread ? (
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              accent
                ? "bg-[var(--accent-purple-strong)]"
                : "bg-[var(--content-default)]",
            )}
            aria-label="Unread replies"
          />
        ) : null}
        <span>
          {rest > 0
            ? `${rest} more ${rest === 1 ? "reply" : "replies"}`
            : expanded
              ? "Reply in thread"
              : "Open thread"}
        </span>
        {options.showTimestamps && last && rest > 0 ? (
          <span className="font-normal text-[var(--content-tertiary)]">
            Last reply {relative(last.at, now)}
          </span>
        ) : null}
        <ChevronRight className="size-3.5 text-[var(--content-tertiary)]" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message row
// ---------------------------------------------------------------------------

interface MessageRowProps {
  message: ProtoMessage;
  /** Consecutive message from the same author as the previous row. */
  continued: boolean;
  thread?: ProtoThread;
  threadOpen: boolean;
  now: number;
  options: ThreadedChatOptions;
  /** Threads cannot nest in the prototype, so replies pass `undefined`. */
  onReply?: () => void;
  onOpenThread?: () => void;
  /** Slot rendered under the message, used by the inline presentation. */
  below?: ReactNode;
  /**
   * Replaces the thread indicator: the assistant's in-thread answer (or a
   * thinking row) drawn under the user's message.
   */
  preview?: ReactNode;
  /** Draw the row as the parent of an open inline thread. */
  highlighted?: boolean;
  /** A reply inside a thread. Uses its own hover group so a hovered parent
   *  row does not reveal every reply's toolbar under it. */
  nested?: boolean;
}

function HoverActions({
  onReply,
  align,
  nested,
}: {
  onReply?: () => void;
  align: "start" | "end";
  nested: boolean;
}) {
  return (
    <div
      className={cn(
        "absolute -top-3 z-10 flex items-center gap-0.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-lift)] p-0.5 shadow-[var(--shadow-sm)] opacity-0 transition-opacity",
        nested
          ? "group-hover/reply:opacity-100 group-focus-within/reply:opacity-100"
          : "group-hover/msg:opacity-100 group-focus-within/msg:opacity-100",
        align === "end" ? "right-0" : "right-2",
      )}
    >
      {onReply ? (
        <Tooltip content="Reply in thread">
          <Button
            variant="ghost"
            size="compact"
            iconOnly={<Reply />}
            aria-label="Reply in thread"
            onClick={onReply}
          />
        </Tooltip>
      ) : null}
      <Tooltip content="React">
        <Button variant="ghost" size="compact" iconOnly={<SmilePlus />} aria-label="React" />
      </Tooltip>
      <Tooltip content="Copy">
        <Button variant="ghost" size="compact" iconOnly={<Copy />} aria-label="Copy" />
      </Tooltip>
    </div>
  );
}

function MessageRow({
  message,
  continued,
  thread,
  threadOpen,
  now,
  options,
  onReply,
  onOpenThread,
  below,
  preview,
  highlighted,
  nested = false,
}: MessageRowProps) {
  const isUser = message.author === "user";
  const hoverGroup = nested ? "group/reply" : "group/msg";
  const compact = options.density === "compact";
  const avatarSize = compact ? 24 : 28;
  const bubbleStyle: CSSProperties = { borderRadius: options.bubbleRadius };
  const rowGap = compact ? "py-1" : "py-2";
  const linearLayout = options.messageStyle !== "bubbles";
  const showHeader = linearLayout && !continued;
  const gutter = options.showAvatars ? avatarSize + 12 : 0;

  const indicator = preview ? (
    preview
  ) : thread && onOpenThread ? (
      <ThreadIndicator
        thread={thread}
        open={threadOpen}
        now={now}
        options={options}
        onOpen={onOpenThread}
        align={!linearLayout && isUser ? "end" : "start"}
      />
    ) : null;

  const body = (
    <MarkdownMessage
      content={message.text}
      className={cn(
        "text-chat [&_p]:my-0 [&_table]:my-2",
        compact && "[&_p]:leading-[22px]",
      )}
    />
  );

  const alwaysReply = options.replyAffordance === "always" && !!onReply;

  // Bubbles: the shipped layout. User text in a right-aligned bubble,
  // assistant text plain beside the avatar.
  if (!linearLayout) {
    return (
      <div
        className={cn(
          hoverGroup,
          "relative flex flex-col",
          rowGap,
          isUser ? "items-end" : "items-start",
          highlighted && "rounded-lg bg-[var(--surface-hover)] px-2 -mx-2",
        )}
        data-message-id={message.id}
      >
        <HoverActions onReply={onReply} align={isUser ? "end" : "start"} nested={nested} />
        {isUser ? (
          <div
            className="flex max-w-[80%] flex-col gap-2 bg-[var(--surface-lift)] px-4 py-3 text-[var(--content-default)]"
            style={bubbleStyle}
          >
            {body}
          </div>
        ) : (
          <div className="flex w-full gap-3">
            {options.showAvatars ? (
              <div className="mt-0.5 shrink-0">
                <Avatar author="assistant" size={avatarSize} />
              </div>
            ) : null}
            <div className="min-w-0 flex-1">
              {options.showTimestamps ? (
                <div className="mb-0.5 flex items-baseline gap-2">
                  <span className="text-body-medium-default text-[var(--content-default)]">
                    {PROTO_ASSISTANT_NAME}
                  </span>
                  <span className="text-label-medium-default text-[var(--content-tertiary)]">
                    {clock(message.at)}
                  </span>
                </div>
              ) : null}
              {body}
            </div>
          </div>
        )}
        {alwaysReply && !thread ? (
          <button
            type="button"
            onClick={onReply}
            className={cn(
              "mt-1 inline-flex items-center gap-1 text-label-medium-default text-[var(--content-quiet)] hover:text-[var(--content-default)]",
              isUser ? "self-end" : options.showAvatars ? "ml-10" : "",
            )}
          >
            <Reply className="size-3" /> Reply
          </button>
        ) : null}
        {indicator ? (
          <div
            className={cn(
              "flex flex-col",
              !isUser && options.showAvatars && !preview && "pl-10",
              preview && "w-full",
            )}
            style={{ alignSelf: isUser && !preview ? "flex-end" : "stretch" }}
          >
            {indicator}
          </div>
        ) : null}
        {below}
      </div>
    );
  }

  // Linear and hybrid: Slack rows. Avatar in a gutter, name and time on the
  // first row of a run, timestamp in the gutter on continued rows.
  const tinted = options.messageStyle === "hybrid" && isUser;
  return (
    <div
      className={cn(
        hoverGroup,
        "relative -mx-3 flex flex-col px-3",
        continued ? (compact ? "py-0.5" : "py-1") : rowGap,
        tinted && "bg-[var(--surface-sunken)]",
        highlighted && "bg-[var(--surface-hover)]",
        !tinted && !highlighted && "hover:bg-[var(--surface-hover)]",
        continued && !highlighted && "rounded-none",
        !continued && "rounded-lg",
      )}
      data-message-id={message.id}
    >
      <HoverActions onReply={onReply} align="start" nested={nested} />
      <div className="flex gap-3">
        {options.showAvatars ? (
          <div className="flex w-7 shrink-0 justify-center pt-0.5" style={{ width: avatarSize }}>
            {continued ? (
              options.showTimestamps ? (
                <span
                  className={cn(
                    "pt-1 text-label-small-default text-[var(--content-faint)] opacity-0",
                    nested ? "group-hover/reply:opacity-100" : "group-hover/msg:opacity-100",
                  )}
                >
                  {clock(message.at).replace(/ (AM|PM)$/, "")}
                </span>
              ) : null
            ) : (
              <Avatar author={message.author} size={avatarSize} />
            )}
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          {showHeader ? (
            <div className="mb-0.5 flex items-baseline gap-2">
              <span className="text-body-medium-default text-[var(--content-default)]">
                {authorName(message.author)}
              </span>
              {options.showTimestamps ? (
                <span className="text-label-medium-default text-[var(--content-tertiary)]">
                  {clock(message.at)}
                </span>
              ) : null}
            </div>
          ) : null}
          {body}
          {alwaysReply && !thread ? (
            <button
              type="button"
              onClick={onReply}
              className="mt-1 inline-flex items-center gap-1 text-label-medium-default text-[var(--content-quiet)] hover:text-[var(--content-default)]"
            >
              <Reply className="size-3" /> Reply
            </button>
          ) : null}
          {indicator ? <div className="flex flex-col">{indicator}</div> : null}
        </div>
      </div>
      {below ? <div style={{ paddingLeft: gutter }}>{below}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transcript (main or thread)
// ---------------------------------------------------------------------------

interface TranscriptProps {
  messages: ProtoMessage[];
  threads?: Record<string, ProtoThread>;
  openThreadId?: string | null;
  now: number;
  options: ThreadedChatOptions;
  onReply?: (messageId: string) => void;
  onOpenThread?: (messageId: string) => void;
  renderBelow?: (message: ProtoMessage) => ReactNode;
  /** The assistant's in-thread answer under a user message, when it has one. */
  renderPreview?: (message: ProtoMessage, thread?: ProtoThread) => ReactNode;
  pending: boolean;
  /** Thread transcripts skip date dividers and never nest. */
  inThread?: boolean;
  compactGutter?: boolean;
}

function Transcript({
  messages,
  threads,
  openThreadId,
  now,
  options,
  onReply,
  onOpenThread,
  renderBelow,
  renderPreview,
  pending,
  inThread,
  compactGutter,
}: TranscriptProps) {
  return (
    <div className="flex flex-col">
      {messages.map((message, i) => {
        const prev = messages[i - 1];
        const newDay = !prev || !sameDay(prev.at, message.at);
        const continued =
          options.groupConsecutive &&
          !!prev &&
          prev.author === message.author &&
          !newDay &&
          message.at - prev.at < 5 * MIN &&
          !(threads && threads[prev.id]);
        const thread = threads?.[message.id];
        return (
          <div key={message.id}>
            {options.showDateDividers && newDay && !inThread ? (
              <DateDivider label={dayLabel(message.at, now)} />
            ) : null}
            <MessageRow
              message={message}
              continued={continued}
              thread={thread}
              threadOpen={openThreadId === message.id}
              now={now}
              options={options}
              onReply={onReply ? () => onReply(message.id) : undefined}
              onOpenThread={onOpenThread ? () => onOpenThread(message.id) : undefined}
              below={renderBelow?.(message)}
              preview={renderPreview?.(message, thread)}
              highlighted={
                options.threadPresentation === "inline" && openThreadId === message.id
              }
              nested={inThread}
            />
          </div>
        );
      })}
      {pending ? <ThinkingRow options={options} compactGutter={!!compactGutter} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thread view (shared by every presentation)
// ---------------------------------------------------------------------------

interface ThreadViewProps {
  parent: ProtoMessage;
  thread: ProtoThread | undefined;
  now: number;
  options: ThreadedChatOptions;
  pending: boolean;
  onSend: (text: string) => void;
  onClose: () => void;
  /** Drill-in shows a back chevron instead of a close X. */
  backStyle: "close" | "back";
  /** Embedded in the main column (inline), so drop the panel chrome. */
  embedded?: boolean;
}

function ThreadView({
  parent,
  thread,
  now,
  options,
  pending,
  onSend,
  onClose,
  backStyle,
  embedded,
}: ThreadViewProps) {
  const replies = thread?.replies ?? [];
  const count = replies.length;
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [count, pending]);

  const parentBlock =
    options.parentInThread === "hidden" ? null : options.parentInThread === "quoted" ? (
      <div className="flex gap-2.5 border-l-2 border-[var(--border-element)] py-0.5 pl-3">
        {options.showAvatars ? <Avatar author={parent.author} size={20} /> : null}
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-body-small-default font-medium text-[var(--content-default)]">
              {authorName(parent.author)}
            </span>
            {options.showTimestamps ? (
              <span className="text-label-small-default text-[var(--content-tertiary)]">
                {clock(parent.at)}
              </span>
            ) : null}
          </div>
          <p className="line-clamp-3 text-body-small-default text-[var(--content-secondary)]">
            {snippet(parent.text)}
          </p>
        </div>
      </div>
    ) : (
      <MessageRow
        message={parent}
        continued={false}
        threadOpen={false}
        now={now}
        options={{ ...options, messageStyle: "linear", replyAffordance: "hover" }}
      />
    );

  return (
    <div
      data-slot="proto-thread"
      className={cn(
        "flex min-h-0 flex-col",
        embedded
          ? "max-h-[420px]"
          : "h-full border-l border-[var(--border-subtle)] bg-[var(--surface-base)]",
      )}
    >
      {!embedded ? (
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3">
          {backStyle === "back" ? (
            <Button
              variant="ghost"
              iconOnly={<ArrowLeft />}
              aria-label="Back to conversation"
              onClick={onClose}
            />
          ) : null}
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="text-body-medium-default text-[var(--content-default)]">
              Thread
            </span>
            <span className="truncate text-body-small-default text-[var(--content-tertiary)]">
              {PROTO_ASSISTANT_NAME}
            </span>
          </div>
          {backStyle === "close" ? (
            <Button
              variant="ghost"
              iconOnly={<X />}
              aria-label="Close thread"
              onClick={onClose}
            />
          ) : null}
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className={cn("min-h-0 flex-1 overflow-y-auto", embedded ? "px-0 pt-2" : "px-4 pt-3")}
      >
        {parentBlock}
        {parentBlock && count > 0 ? (
          <div className="my-2 flex items-center gap-2">
            <span className="text-label-medium-default text-[var(--content-tertiary)]">
              {count} {count === 1 ? "reply" : "replies"}
            </span>
            <div className="h-px flex-1 bg-[var(--border-subtle)]" />
          </div>
        ) : null}
        <Transcript
          messages={replies}
          now={now}
          options={{ ...options, messageStyle: options.messageStyle === "bubbles" ? "bubbles" : "linear" }}
          pending={pending}
          inThread
        />
        <div className="h-3" />
      </div>

      <div className={cn("shrink-0", embedded ? "pb-2 pt-1" : "px-3 pb-3 pt-1")}>
        <Composer
          placeholder={`Reply to ${authorName(parent.author)}`}
          onSend={onSend}
          options={options}
          autoFocus
          compact
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Threads list (the "Threads" rail destination, replacing the chats sidebar)
// ---------------------------------------------------------------------------

function ThreadsList({
  state,
  now,
  options,
  onOpen,
}: {
  state: ProtoState;
  now: number;
  options: ThreadedChatOptions;
  onOpen: (parentId: string) => void;
}) {
  const items = Object.values(state.threads)
    .map((thread) => ({
      thread,
      parent: state.main.find((m) => m.id === thread.parentMessageId),
      last: thread.replies[thread.replies.length - 1],
    }))
    .filter((it) => it.parent && it.last)
    .sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0));

  return (
    <div className="mx-auto w-full px-4 py-4" style={{ maxWidth: options.maxContentWidth }}>
      <h2 className="mb-3 text-title-small text-[var(--content-default)]">Threads</h2>
      <div className="flex flex-col gap-2">
        {items.map(({ thread, parent, last }) => (
          <button
            key={thread.conversationId}
            type="button"
            onClick={() => onOpen(thread.parentMessageId)}
            className="flex flex-col gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-lift)] p-3 text-left transition-colors hover:border-[var(--border-element)]"
          >
            <div className="flex items-center gap-2">
              {thread.unread > 0 ? (
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    options.accentThreads
                      ? "bg-[var(--accent-purple-strong)]"
                      : "bg-[var(--content-default)]",
                  )}
                />
              ) : null}
              <span className="line-clamp-1 text-body-medium-default text-[var(--content-default)]">
                {parent ? snippet(parent.text) : ""}
              </span>
            </div>
            <div className="flex items-center gap-2 text-body-small-default text-[var(--content-secondary)]">
              {options.showAvatars && last ? <Avatar author={last.author} size={18} /> : null}
              <span className="line-clamp-1 flex-1">
                <span className="font-medium">{last ? authorName(last.author) : ""}:</span>{" "}
                {last ? snippet(last.text) : ""}
              </span>
              <span className="shrink-0 text-[var(--content-tertiary)]">
                {thread.replies.length} {thread.replies.length === 1 ? "reply" : "replies"}
                {options.showTimestamps && last ? ` · ${relative(last.at, now)}` : ""}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Left rail
// ---------------------------------------------------------------------------

function Rail({
  mode,
  view,
  unreadThreads,
  onSelect,
}: {
  mode: LeftRail;
  view: View;
  unreadThreads: number;
  onSelect: (view: View) => void;
}) {
  if (mode === "none") {
    return null;
  }
  const labeled = mode === "labeled";
  const items: { key: View | "saved" | "search"; label: string; icon: ReactNode; badge?: number }[] = [
    { key: "main", label: "Home", icon: <Home /> },
    { key: "threads", label: "Threads", icon: <MessagesSquare />, badge: unreadThreads },
    { key: "saved", label: "Saved", icon: <Bookmark /> },
    { key: "search", label: "Search", icon: <Search /> },
  ];
  return (
    <nav
      data-slot="proto-rail"
      className={cn(
        "flex h-full shrink-0 flex-col gap-1 border-r border-[var(--border-subtle)] bg-[var(--surface-sunken)] py-3",
        labeled ? "w-52 px-2" : "w-14 items-center px-1.5",
      )}
      aria-label="Primary"
    >
      <div className={cn("mb-2 flex items-center gap-2", labeled ? "px-2" : "")}>
        <Avatar author="assistant" size={28} />
        {labeled ? (
          <span className="text-body-medium-default text-[var(--content-default)]">
            {PROTO_ASSISTANT_NAME}
          </span>
        ) : null}
      </div>
      {items.map((item) => {
        const active = item.key === view;
        const button = (
          <button
            key={item.key}
            type="button"
            onClick={() => {
              if (item.key === "main" || item.key === "threads") {
                onSelect(item.key);
              }
            }}
            aria-current={active ? "page" : undefined}
            aria-label={item.label}
            className={cn(
              "relative flex items-center gap-2.5 rounded-md text-body-medium-default transition-colors [&_svg]:size-4.5",
              labeled ? "h-8 w-full px-2" : "size-10 justify-center",
              active
                ? "bg-[var(--surface-active)] text-[var(--content-default)]"
                : "text-[var(--content-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)]",
            )}
          >
            {item.icon}
            {labeled ? <span className="flex-1 text-left">{item.label}</span> : null}
            {item.badge ? (
              <span
                className={cn(
                  "flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--primary-base)] px-1 text-label-small-default text-[var(--content-inset)]",
                  !labeled && "absolute -right-0.5 -top-0.5",
                )}
              >
                {item.badge}
              </span>
            ) : null}
          </button>
        );
        return labeled ? (
          button
        ) : (
          <Tooltip key={item.key} content={item.label} side="right">
            {button}
          </Tooltip>
        );
      })}
      <div className="flex-1" />
      <Button variant="ghost" iconOnly={<Settings />} aria-label="Settings" />
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

function TopBar({
  view,
  threadCount,
  onShowThreads,
}: {
  view: View;
  threadCount: number;
  onShowThreads: () => void;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="text-body-medium-default text-[var(--content-default)]">
          {view === "main" ? PROTO_ASSISTANT_NAME : "Threads"}
        </span>
        {view === "main" ? (
          <span className="flex items-center gap-1.5 text-body-small-default text-[var(--content-tertiary)]">
            <span className="size-1.5 rounded-full bg-[var(--system-positive-strong,var(--accent-purple-strong))]" />
            Online
          </span>
        ) : null}
      </div>
      {view === "main" ? (
        <Button variant="ghost" size="compact" onClick={onShowThreads}>
          <MessagesSquare className="size-4" />
          {threadCount} threads
        </Button>
      ) : null}
      <Button variant="ghost" iconOnly={<Search />} aria-label="Search this conversation" />
    </header>
  );
}

// ---------------------------------------------------------------------------
// The prototype
// ---------------------------------------------------------------------------

/**
 * Picks the seed for the reply mode and remounts the chat when the mode
 * changes, since the conversation state is seeded once.
 */
export function ThreadedChatPrototype(props: ThreadedChatPrototypeProps) {
  const repliesInThread = props.assistantRepliesIn === "thread";
  const seed =
    props.seed ?? (repliesInThread ? ASSISTANT_IN_THREAD_SEED : SEED_STATE);
  return (
    <ThreadedChat key={props.assistantRepliesIn} {...props} seed={seed} />
  );
}

function ThreadedChat({
  initialOpenThreadId = null,
  seed = SEED_STATE,
  ...options
}: ThreadedChatPrototypeProps) {
  const repliesInThread = options.assistantRepliesIn === "thread";
  const { state, pending, now, send, markRead, lastAnswered, clearLastAnswered } =
    useProtoChat(seed, options.mockAssistantReplies, repliesInThread);
  const [view, setView] = useState<View>("main");
  const [openThreadId, setOpenThreadId] = useState<string | null>(initialOpenThreadId);
  // The thread the main composer continues, in `thread` reply mode. `null`
  // sends a new top-level message.
  const [composerTarget, setComposerTarget] = useState<string | null>(null);
  const reduce = useReducedMotion();
  const duration = reduce ? 0 : options.animationMs / 1000;
  const mainScrollRef = useRef<HTMLDivElement>(null);
  const mainCount = state.main.length;
  const replyCount = Object.values(state.threads).reduce(
    (sum, t) => sum + t.replies.length,
    0,
  );

  useEffect(() => {
    const el = mainScrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [mainCount, replyCount, pending]);

  // After the assistant answers in a thread, the composer follows it.
  useEffect(() => {
    if (lastAnswered == null) {
      return;
    }
    if (repliesInThread && options.followUpDefault === "thread") {
      setComposerTarget(lastAnswered);
    }
    clearLastAnswered();
  }, [lastAnswered, repliesInThread, options.followUpDefault, clearLastAnswered]);

  const openThread = useCallback(
    (id: string) => {
      setOpenThreadId(id);
      setView("main");
      markRead(id);
    },
    [markRead],
  );
  const closeThread = useCallback(() => setOpenThreadId(null), []);

  const parent = useMemo(
    () => (openThreadId ? state.main.find((m) => m.id === openThreadId) ?? null : null),
    [openThreadId, state.main],
  );
  const activeThread = openThreadId ? state.threads[openThreadId] : undefined;
  const pendingInThread =
    pending != null && pending.parentMessageId != null && pending.parentMessageId === openThreadId;
  const pendingInMain = pending != null && pending.parentMessageId === null;
  const unreadThreads = Object.values(state.threads).filter((t) => t.unread > 0).length;
  const presentation = options.threadPresentation;

  const threadView =
    parent != null ? (
      <ThreadView
        parent={parent}
        thread={activeThread}
        now={now}
        options={options}
        pending={pendingInThread}
        onSend={(text) => send(parent.id, text)}
        onClose={closeThread}
        backStyle={presentation === "drill-in" ? "back" : "close"}
        embedded={presentation === "inline"}
      />
    ) : null;

  const contentStyle: CSSProperties = { maxWidth: options.maxContentWidth };

  // In `thread` reply mode the answer peeks into the main feed under the
  // user's message. The newest exchange is the one the user is in the middle
  // of, so `expanded-latest` shows it whole.
  const latestMainId = state.main[state.main.length - 1]?.id ?? null;
  const renderPreview =
    repliesInThread && options.replyPreview !== "none"
      ? (message: ProtoMessage, thread?: ProtoThread): ReactNode => {
          if (pending?.parentMessageId === message.id && !thread) {
            return <ThinkingRow options={options} compactGutter={false} />;
          }
          if (!thread) {
            return undefined;
          }
          return (
            <>
              <ReplyPreview
                thread={thread}
                expanded={
                  options.replyPreview === "expanded-latest" &&
                  message.id === latestMainId
                }
                open={openThreadId === message.id}
                now={now}
                options={options}
                onOpen={() => openThread(message.id)}
              />
              {pending?.parentMessageId === message.id ? (
                <ThinkingRow options={options} compactGutter={false} />
              ) : null}
            </>
          );
        }
      : undefined;

  const composerContext =
    repliesInThread && composerTarget
      ? {
          label: snippet(
            state.main.find((m) => m.id === composerTarget)?.text ?? "",
          ),
          onClear: () => setComposerTarget(null),
        }
      : null;

  const mainColumn = (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <TopBar
        view={view}
        threadCount={Object.keys(state.threads).length}
        onShowThreads={() => setView("threads")}
      />
      {view === "threads" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ThreadsList state={state} now={now} options={options} onOpen={openThread} />
        </div>
      ) : (
        <>
          <div ref={mainScrollRef} className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full px-4 pt-4" style={contentStyle}>
              <Transcript
                messages={state.main}
                threads={state.threads}
                openThreadId={openThreadId}
                now={now}
                options={options}
                onReply={openThread}
                onOpenThread={openThread}
                pending={pendingInMain}
                renderPreview={renderPreview}
                renderBelow={
                  presentation === "inline"
                    ? (message) => (
                        <AnimatePresence initial={false}>
                          {openThreadId === message.id && threadView ? (
                            <motion.div
                              key="inline-thread"
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration, ease: [0.16, 1, 0.3, 1] }}
                              className="overflow-hidden"
                            >
                              <div
                                className={cn(
                                  "mt-2 border-l-2 pl-3",
                                  options.accentThreads
                                    ? "border-[var(--accent-purple-strong)]"
                                    : "border-[var(--border-element)]",
                                )}
                              >
                                <div className="flex items-center justify-between">
                                  <span className="text-label-medium-default text-[var(--content-tertiary)]">
                                    Thread
                                  </span>
                                  <Button
                                    variant="ghost"
                                    size="compact"
                                    iconOnly={<X />}
                                    aria-label="Collapse thread"
                                    onClick={closeThread}
                                  />
                                </div>
                                {threadView}
                              </div>
                            </motion.div>
                          ) : null}
                        </AnimatePresence>
                      )
                    : undefined
                }
              />
              <div className="h-4" />
            </div>
          </div>
          <div className="shrink-0 px-4 pb-4">
            <div className="mx-auto w-full" style={contentStyle}>
              <Composer
                placeholder={`Message ${PROTO_ASSISTANT_NAME}`}
                onSend={(text) =>
                  send(composerContext ? composerTarget : null, text)
                }
                options={options}
                context={composerContext}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );

  let body: ReactNode;
  if (presentation === "side-panel") {
    body = (
      <AnimatedRightDrawer
        key={options.threadPanelWidth}
        open={threadView != null}
        left={mainColumn}
        right={threadView}
        defaultWidth={options.threadPanelWidth}
        minWidth={320}
        minLeftWidth={360}
      />
    );
  } else if (presentation === "drill-in") {
    body = (
      <div className="relative h-full w-full overflow-hidden">
        <motion.div
          className="absolute inset-0"
          animate={{ x: threadView ? -48 : 0, opacity: threadView ? 0.4 : 1 }}
          transition={{ duration, ease: [0.16, 1, 0.3, 1] }}
          aria-hidden={threadView != null}
        >
          {mainColumn}
        </motion.div>
        <AnimatePresence>
          {threadView ? (
            <motion.div
              key={openThreadId}
              className="absolute inset-0 bg-[var(--surface-base)] shadow-[var(--shadow-lg)]"
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ duration, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className="mx-auto h-full w-full" style={contentStyle}>
                {threadView}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    );
  } else if (presentation === "overlay") {
    body = (
      <div className="relative h-full w-full overflow-hidden">
        {mainColumn}
        <AnimatePresence>
          {threadView ? (
            <motion.div
              key="overlay"
              className="absolute inset-0 z-20 flex items-center justify-center bg-[var(--primary-base)]/35 p-6"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration }}
              onClick={closeThread}
            >
              <motion.div
                className="h-full max-h-[720px] w-full max-w-[640px] overflow-hidden rounded-xl bg-[var(--surface-base)] shadow-[var(--shadow-popover)] ring-1 ring-[var(--border-subtle)]"
                initial={{ scale: 0.96, y: 12 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.96, y: 12 }}
                transition={{ duration, ease: [0.16, 1, 0.3, 1] }}
                onClick={(event) => event.stopPropagation()}
                role="dialog"
                aria-label="Thread"
              >
                {threadView}
              </motion.div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    );
  } else {
    body = mainColumn;
  }

  return (
    <div
      data-slot="threaded-chat-prototype"
      className="flex h-dvh w-full overflow-hidden bg-[var(--surface-base)] text-[var(--content-default)]"
    >
      <Rail
        mode={options.leftRail}
        view={view}
        unreadThreads={unreadThreads}
        onSelect={(next) => {
          setView(next);
          if (next === "threads") {
            closeThread();
          }
        }}
      />
      <div className="min-w-0 flex-1">{body}</div>
    </div>
  );
}
