/**
 * Design prototype: the calendar as a surface the assistant lives on.
 *
 * A day grid with events from several calendars, the blocks the user planned
 * with what the assistant recorded actually happening in them, and the
 * assistant's comments pinned to the events it has something to say about
 * (brief ready, conflict, leave by). Clicking anything opens a thread about
 * it in a drawer, so talking about an event happens on the event.
 *
 * Prototype state only; nothing is wired to a calendar provider.
 */

/* eslint-disable local/no-untranslated-strings -- design prototype rendered
   only in Storybook; its copy is fixture text, not shipped UI. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bell,
  ChevronLeft,
  ChevronRight,
  Clock,
  MapPin,
  MessageSquare,
  Sparkles,
  X,
} from "lucide-react";

import { Button, MarkdownMessage, Tooltip } from "@vellumai/design-library";

import { AnimatedRightDrawer } from "@/domains/chat/components/animated-right-drawer";
import { cn } from "@/utils/misc";

import {
  MOCK_REPLIES,
  PROTO_ASSISTANT_NAME,
  type ProtoMessage,
  type ProtoThread,
} from "../threaded-chat/fixtures";
import {
  Avatar,
  Composer,
  DEFAULT_THREADED_CHAT_OPTIONS,
  ThinkingRow,
  authorName,
  clock,
} from "../threaded-chat/threaded-chat-prototype";
import {
  CALENDAR_LABELS,
  DAY_SEED,
  at,
  type AgendaItem,
  type CalendarKey,
  type DaySeed,
} from "./day-fixtures";

// ---------------------------------------------------------------------------
// Options (the Storybook knobs)
// ---------------------------------------------------------------------------

export interface CalendarPageOptions {
  /** Pixels per hour in the grid. */
  hourHeight: number;
  startHour: number;
  endHour: number;
  /** Where the now line sits. */
  nowHour: number;
  /** The assistant's comments drawn on events. */
  showComments: boolean;
  /** Planned blocks show what actually happened as a fill. */
  showActual: boolean;
  /** The week strip above the grid. */
  showWeekStrip: boolean;
  /** Which calendars are visible. */
  showWork: boolean;
  showPersonal: boolean;
  showFamily: boolean;
  /** Where the assistant's comment sits on an event card. */
  commentPlacement: "inside" | "margin";
  /** Thread drawer width in px. */
  drawerWidth: number;
  /** Colour the calendar an event belongs to. */
  calendarColors: boolean;
}

export const DEFAULT_CALENDAR_PAGE_OPTIONS: CalendarPageOptions = {
  hourHeight: 64,
  startHour: 7,
  endHour: 21,
  nowHour: 15.5,
  showComments: true,
  showActual: true,
  showWeekStrip: true,
  showWork: true,
  showPersonal: true,
  showFamily: true,
  commentPlacement: "inside",
  drawerWidth: 420,
  calendarColors: true,
};

export interface CalendarPagePrototypeProps extends CalendarPageOptions {
  seed?: DaySeed;
  initialOpenId?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MIN = 60_000;
const HOUR = 60 * MIN;

const CALENDAR_STRONG: Record<CalendarKey, string> = {
  work: "var(--accent-purple-strong)",
  personal: "var(--system-positive-strong)",
  family: "var(--accent-orange-strong)",
};
const CALENDAR_WEAK: Record<CalendarKey, string> = {
  work: "var(--accent-purple-weak)",
  personal: "var(--system-positive-weak, var(--surface-sunken))",
  family: "var(--accent-orange-weak)",
};

function shortClock(ms: number): string {
  return clock(ms).replace(/ (AM|PM)$/, "");
}

function hourLabel(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h} ${hour < 12 ? "AM" : "PM"}`;
}

// ---------------------------------------------------------------------------
// State (same shape as the day panel, kept local so the story stands alone)
// ---------------------------------------------------------------------------

function useDayThreads(seed: DaySeed, baseNow: number) {
  const [items, setItems] = useState<AgendaItem[]>(seed.items);
  const [pendingId, setPendingId] = useState<string | null>(null);
  // Sends push the clock forward from where the knob put "now".
  const [offset, setOffset] = useState(0);
  const clockNow = baseNow + offset;
  const replyIndex = useRef(0);

  const appendReply = useCallback(
    (id: string, author: ProtoMessage["author"], text: string) => {
      const step = author === "user" ? 15_000 : 30_000;
      const atMs = clockNow + step;
      setOffset((o) => o + step);
      setItems((prev) =>
        prev.map((it) => {
          if (it.id !== id) {
            return it;
          }
          const message: ProtoMessage = { id: `${id}-${atMs}`, author, text, at: atMs };
          const thread: ProtoThread = it.thread
            ? { ...it.thread, replies: [...it.thread.replies, message], unread: 0 }
            : { conversationId: `thread-${id}`, parentMessageId: id, replies: [message], unread: 0 };
          return { ...it, thread };
        }),
      );
    },
    [clockNow],
  );

  const send = useCallback(
    (id: string, text: string) => {
      appendReply(id, "user", text);
      setPendingId(id);
    },
    [appendReply],
  );

  useEffect(() => {
    if (pendingId == null) {
      return;
    }
    const timer = window.setTimeout(() => {
      const text = MOCK_REPLIES[replyIndex.current % MOCK_REPLIES.length];
      replyIndex.current += 1;
      appendReply(pendingId, "assistant", text);
      setPendingId(null);
    }, 1100);
    return () => window.clearTimeout(timer);
  }, [pendingId, appendReply]);

  const markRead = useCallback((id: string) => {
    setItems((prev) =>
      prev.map((it) =>
        it.id === id && it.thread && it.thread.unread > 0
          ? { ...it, thread: { ...it.thread, unread: 0 } }
          : it,
      ),
    );
  }, []);

  return { items, pendingId, send, markRead };
}

// ---------------------------------------------------------------------------
// Grid pieces
// ---------------------------------------------------------------------------

function CommentChip({ item, onOpen }: { item: AgendaItem; onOpen: () => void }) {
  if (!item.note) {
    return null;
  }
  const warn = item.note.tone === "warn";
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      className={cn(
        "flex max-w-full items-start gap-1.5 rounded-md px-1.5 py-1 text-left text-label-medium-default leading-[14px] transition-colors",
        warn
          ? "bg-[var(--accent-orange-weak)] text-[var(--content-default)] hover:brightness-95"
          : "bg-[var(--surface-lift)] text-[var(--content-secondary)] ring-1 ring-[var(--border-subtle)] hover:text-[var(--content-default)]",
      )}
    >
      <span className="mt-px shrink-0">
        {warn ? (
          <AlertTriangle className="size-3 text-[var(--accent-orange-strong)]" />
        ) : (
          <Avatar author="assistant" size={14} />
        )}
      </span>
      <span className="line-clamp-2">{item.note.text}</span>
    </button>
  );
}

interface EventCardProps {
  item: AgendaItem;
  options: CalendarPageOptions;
  open: boolean;
  now: number;
  onOpen: () => void;
  /** Column offset and width, as fractions, for overlapping events. */
  lane: { index: number; count: number };
}

function EventCard({ item, options, open, now, onOpen, lane }: EventCardProps) {
  if (item.start == null) {
    return null;
  }
  const end = item.end ?? item.start + 30 * MIN;
  const top = ((item.start - at(options.startHour)) / HOUR) * options.hourHeight;
  const height = Math.max(22, ((end - item.start) / HOUR) * options.hourHeight);
  const isPast = end <= now;
  const isBlock = item.kind === "block";
  const isReminder = item.kind === "reminder";
  const isTask = item.kind === "task";
  const strong = options.calendarColors && item.calendar ? CALENDAR_STRONG[item.calendar] : "var(--content-tertiary)";
  const weak = options.calendarColors && item.calendar ? CALENDAR_WEAK[item.calendar] : "var(--surface-sunken)";
  const replies = item.thread?.replies.length ?? 0;
  const unread = (item.thread?.unread ?? 0) > 0;
  const laneLeft = `${(lane.index / lane.count) * 100}%`;
  const laneWidth = `calc(${100 / lane.count}% - 4px)`;
  const tall = height >= 56;
  const showInsideComment =
    options.showComments &&
    options.commentPlacement === "inside" &&
    item.note != null &&
    height >= 58;
  // A one-hour card has room for the title and one of: the time row or the
  // comment. The comment wins; the time is in the drawer and the gutter.
  const showTimeRow = tall && (!showInsideComment || height >= 84);

  let actualFill: number | null = null;
  if (isBlock && options.showActual && item.actual) {
    const planned = (end - item.start) / MIN;
    actualFill = Math.min(1, item.actual.onPlanMinutes / planned);
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      aria-current={open ? "true" : undefined}
      className={cn(
        "group/event absolute flex flex-col overflow-hidden rounded-md text-left transition-shadow",
        isReminder || isTask
          ? "border border-[var(--border-element)] bg-[var(--surface-lift)] px-2 py-1"
          : isBlock
            ? "border border-dashed px-2 py-1"
            : "px-2 py-1",
        open ? "shadow-[var(--shadow-md)] ring-2 ring-[var(--border-active)]" : "hover:shadow-[var(--shadow-sm)]",
        isPast && !open && "opacity-70 hover:opacity-100",
      )}
      style={{
        top,
        height,
        left: laneLeft,
        width: laneWidth,
        background: isBlock ? "var(--surface-overlay)" : isReminder || isTask ? undefined : weak,
        borderColor: isBlock ? strong : undefined,
        borderLeft: isBlock || isReminder || isTask ? undefined : `3px solid ${strong}`,
      }}
    >
      {actualFill != null ? (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0"
          style={{
            height: `${actualFill * 100}%`,
            background: "var(--system-positive-strong)",
            opacity: 0.18,
          }}
          aria-hidden
        />
      ) : null}
      <div className="relative flex min-w-0 items-center gap-1.5">
        {isReminder ? <Bell className="size-3 shrink-0 text-[var(--content-tertiary)]" /> : null}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-body-small-default font-medium",
            "text-[var(--content-default)]",
          )}
        >
          {item.title}
        </span>
        {replies > 0 ? (
          <span
            className={cn(
              "flex shrink-0 items-center gap-0.5 text-label-small-default",
              unread ? "text-[var(--accent-orange-strong)]" : "text-[var(--content-tertiary)]",
            )}
          >
            <MessageSquare className="size-3" />
            {replies}
          </span>
        ) : null}
      </div>
      {showTimeRow ? (
        <div className="relative mt-0.5 flex items-center gap-2 text-label-medium-default text-[var(--content-tertiary)]">
          <span className="tabular-nums">
            {shortClock(item.start)} to {clock(end)}
          </span>
          {item.location ? (
            <span className="flex min-w-0 items-center gap-0.5">
              <MapPin className="size-3 shrink-0" />
              <span className="truncate">{item.location}</span>
            </span>
          ) : null}
        </div>
      ) : null}
      {isBlock && item.actual && options.showActual && tall ? (
        <p className="relative mt-1 line-clamp-2 text-label-medium-default leading-[14px] text-[var(--content-secondary)]">
          {item.actual.summary}
        </p>
      ) : null}
      {showInsideComment ? (
        <div className="relative mt-auto pt-1">
          <CommentChip item={item} onOpen={onOpen} />
        </div>
      ) : null}
    </div>
  );
}

/** Assigns overlapping timed items to side-by-side lanes. */
function assignLanes(items: AgendaItem[]): Map<string, { index: number; count: number }> {
  const lanes = new Map<string, { index: number; count: number }>();
  const sorted = [...items].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  let cluster: AgendaItem[] = [];
  let clusterEnd = 0;
  const flush = () => {
    const ends: number[] = [];
    const assigned: { item: AgendaItem; index: number }[] = [];
    for (const it of cluster) {
      const start = it.start ?? 0;
      let index = ends.findIndex((e) => e <= start);
      if (index === -1) {
        index = ends.length;
        ends.push(0);
      }
      ends[index] = it.end ?? start + 30 * MIN;
      assigned.push({ item: it, index });
    }
    for (const a of assigned) {
      lanes.set(a.item.id, { index: a.index, count: ends.length });
    }
    cluster = [];
    clusterEnd = 0;
  };
  for (const it of sorted) {
    const start = it.start ?? 0;
    const end = it.end ?? start + 30 * MIN;
    if (cluster.length && start >= clusterEnd) {
      flush();
    }
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, end);
  }
  if (cluster.length) {
    flush();
  }
  return lanes;
}

// ---------------------------------------------------------------------------
// Thread drawer
// ---------------------------------------------------------------------------

function EventThread({
  item,
  pending,
  onSend,
  onClose,
  options,
}: {
  item: AgendaItem;
  pending: boolean;
  onSend: (text: string) => void;
  onClose: () => void;
  options: CalendarPageOptions;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const count = item.thread?.replies.length ?? 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [count, pending]);
  const strong = options.calendarColors && item.calendar ? CALENDAR_STRONG[item.calendar] : "var(--content-faint)";

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-[var(--border-subtle)] bg-[var(--surface-base)]">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3">
        <span className="size-2.5 shrink-0 rounded-full" style={{ background: strong }} />
        <span className="min-w-0 flex-1 truncate text-body-medium-default">{item.title}</span>
        <Button variant="ghost" iconOnly={<X />} aria-label="Close" onClick={onClose} />
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-body-small-default text-[var(--content-secondary)]">
          {item.start != null ? (
            <span className="flex items-center gap-1">
              <Clock className="size-3.5" />
              {shortClock(item.start)}
              {item.end != null ? ` to ${clock(item.end)}` : ""}
            </span>
          ) : null}
          {item.location ? (
            <span className="flex items-center gap-1">
              <MapPin className="size-3.5" /> {item.location}
            </span>
          ) : null}
          {item.calendar ? <span>{CALENDAR_LABELS[item.calendar]}</span> : null}
        </div>
        {item.note ? (
          <div
            className={cn(
              "mb-4 flex items-start gap-2 rounded-lg px-3 py-2 text-body-medium-default font-normal",
              item.note.tone === "warn" ? "bg-[var(--accent-orange-weak)]" : "bg-[var(--surface-sunken)]",
            )}
          >
            <span className="mt-0.5">
              {item.note.tone === "warn" ? (
                <AlertTriangle className="size-3.5 text-[var(--accent-orange-strong)]" />
              ) : (
                <Sparkles className="size-3.5 text-[var(--accent-purple-strong)]" />
              )}
            </span>
            <span>{item.note.text}</span>
          </div>
        ) : null}
        <div className="flex flex-col gap-4">
          {count === 0 && !pending ? (
            <p className="text-body-medium-default font-normal text-[var(--content-tertiary)]">
              Ask {PROTO_ASSISTANT_NAME} anything about this.
            </p>
          ) : null}
          {item.thread?.replies.map((reply) =>
            reply.author === "user" ? (
              <div key={reply.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-xl bg-[var(--surface-lift)] px-3.5 py-2.5">
                  <MarkdownMessage content={reply.text} className="text-chat [&_p]:my-0" />
                </div>
              </div>
            ) : (
              <div key={reply.id} className="flex gap-2.5">
                <div className="mt-0.5 shrink-0">
                  <Avatar author="assistant" size={24} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="mb-0.5 flex items-baseline gap-2">
                    <span className="text-body-medium-default">{authorName(reply.author)}</span>
                    <span className="text-label-medium-default text-[var(--content-tertiary)]">
                      {clock(reply.at)}
                    </span>
                  </div>
                  <MarkdownMessage content={reply.text} className="text-chat [&_p]:my-0" />
                </div>
              </div>
            ),
          )}
          {pending ? <ThinkingRow options={DEFAULT_THREADED_CHAT_OPTIONS} compactGutter={false} /> : null}
        </div>
      </div>
      <div className="shrink-0 px-3 pb-3">
        <Composer
          placeholder={`Ask about ${item.title}`}
          onSend={onSend}
          options={DEFAULT_THREADED_CHAT_OPTIONS}
          autoFocus
          compact
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Week strip
// ---------------------------------------------------------------------------

function WeekStrip({ now }: { now: number }) {
  const today = new Date(now);
  const weekday = today.getUTCDay();
  const monday = now - ((weekday + 6) % 7) * 24 * HOUR;
  const days = Array.from({ length: 7 }, (_, i) => monday + i * 24 * HOUR);
  return (
    <div className="flex items-center gap-1">
      {days.map((d) => {
        const date = new Date(d);
        const isToday = date.getUTCDate() === today.getUTCDate();
        return (
          <button
            key={d}
            type="button"
            className={cn(
              "flex min-w-11 flex-col items-center rounded-md px-2 py-1 text-label-medium-default",
              isToday
                ? "bg-[var(--primary-base)] text-[var(--content-inset)]"
                : "text-[var(--content-tertiary)] hover:bg-[var(--surface-hover)]",
            )}
          >
            <span>{date.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })}</span>
            <span className={cn("text-body-medium-default", !isToday && "text-[var(--content-default)]")}>
              {date.getUTCDate()}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The prototype
// ---------------------------------------------------------------------------

export function CalendarPagePrototype({
  seed = DAY_SEED,
  initialOpenId = null,
  ...options
}: CalendarPagePrototypeProps) {
  const now = at(options.nowHour);
  const { items, pendingId, send, markRead } = useDayThreads(seed, now);
  const [openId, setOpenId] = useState<string | null>(initialOpenId);
  const gridRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(
    () =>
      items.filter((it) => {
        if (it.start == null) {
          return false;
        }
        if (it.calendar === "work" && !options.showWork) {
          return false;
        }
        if (it.calendar === "personal" && !options.showPersonal) {
          return false;
        }
        if (it.calendar === "family" && !options.showFamily) {
          return false;
        }
        return true;
      }),
    [items, options.showWork, options.showPersonal, options.showFamily],
  );
  const lanes = useMemo(() => assignLanes(visible), [visible]);
  const floating = items.filter((it) => it.start == null);
  const open = items.find((it) => it.id === openId) ?? null;

  const openItem = useCallback(
    (id: string) => {
      setOpenId(id);
      markRead(id);
    },
    [markRead],
  );

  // Scroll the grid so now sits a third of the way down on load.
  useEffect(() => {
    const el = gridRef.current;
    if (el) {
      const y = (options.nowHour - options.startHour) * options.hourHeight;
      el.scrollTop = Math.max(0, y - el.clientHeight / 3);
    }
    // Only on mount: later knob changes should not yank the scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hours = Array.from(
    { length: options.endHour - options.startHour },
    (_, i) => options.startHour + i,
  );
  const nowTop = (options.nowHour - options.startHour) * options.hourHeight;
  const gridHeight = hours.length * options.hourHeight;
  const dateLabel = new Date(now).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  const needsYou = items.filter((it) => it.status === "waiting-on-you");

  const page = (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--border-subtle)] px-5 py-3">
        <div className="flex items-center gap-1">
          <Button variant="ghost" iconOnly={<ChevronLeft />} aria-label="Previous day" />
          <Button variant="ghost" iconOnly={<ChevronRight />} aria-label="Next day" />
        </div>
        <h1 className="text-title-small text-[var(--content-default)]">{dateLabel}</h1>
        <span className="text-body-small-default text-[var(--content-tertiary)]">Today</span>
        {options.showWeekStrip ? (
          <div className="ml-auto">
            <WeekStrip now={now} />
          </div>
        ) : null}
        <div className="flex items-center gap-3 text-label-medium-default text-[var(--content-tertiary)]">
          {(["work", "personal", "family"] as CalendarKey[]).map((key) => (
            <span key={key} className="flex items-center gap-1">
              <span
                className="size-2 rounded-full"
                style={{ background: options.calendarColors ? CALENDAR_STRONG[key] : "var(--content-faint)" }}
              />
              {CALENDAR_LABELS[key]}
            </span>
          ))}
        </div>
      </header>

      {needsYou.length || floating.length ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-5 py-2">
          <span className="flex items-center gap-1.5 text-label-medium-default uppercase tracking-wide text-[var(--content-tertiary)]">
            <Sparkles className="size-3" /> From {PROTO_ASSISTANT_NAME}
          </span>
          {floating.map((it) => (
            <button
              key={it.id}
              type="button"
              onClick={() => openItem(it.id)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-body-small-default transition-colors",
                it.status === "waiting-on-you"
                  ? "border-[var(--accent-orange-strong)] bg-[var(--accent-orange-weak)] text-[var(--content-default)]"
                  : "border-[var(--border-subtle)] bg-[var(--surface-lift)] text-[var(--content-secondary)] hover:text-[var(--content-default)]",
                openId === it.id && "ring-2 ring-[var(--border-active)]",
              )}
            >
              {it.status === "waiting-on-you" ? (
                <AlertTriangle className="size-3 text-[var(--accent-orange-strong)]" />
              ) : null}
              {it.title}
              {it.note ? (
                <span className="text-[var(--content-tertiary)]">· {it.note.text}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      <div ref={gridRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="relative mx-auto flex w-full max-w-[1100px] px-5 py-4">
          {/* Hour gutter */}
          <div className="relative w-14 shrink-0" style={{ height: gridHeight }}>
            {hours.map((h, i) => (
              <div
                key={h}
                className="absolute right-3 -translate-y-1/2 text-label-medium-default tabular-nums text-[var(--content-tertiary)]"
                style={{ top: i * options.hourHeight }}
              >
                {i === 0 ? "" : hourLabel(h)}
              </div>
            ))}
          </div>
          {/* Day column */}
          <div className="relative min-w-0 flex-1" style={{ height: gridHeight }}>
            {hours.map((h, i) => (
              <div
                key={h}
                className="absolute inset-x-0 border-t border-[var(--border-subtle)]"
                style={{ top: i * options.hourHeight }}
                aria-hidden
              />
            ))}
            {visible.map((it) => (
              <EventCard
                key={it.id}
                item={it}
                options={options}
                open={openId === it.id}
                now={now}
                onOpen={() => openItem(it.id)}
                lane={lanes.get(it.id) ?? { index: 0, count: 1 }}
              />
            ))}
            {/* Now line */}
            {options.nowHour >= options.startHour && options.nowHour <= options.endHour ? (
              <div
                className="pointer-events-none absolute inset-x-0 z-10 flex items-center"
                style={{ top: nowTop }}
                aria-label="Now"
              >
                <span className="-ml-1 size-2 rounded-full bg-[var(--accent-orange-strong)]" />
                <span className="h-px flex-1 bg-[var(--accent-orange-strong)]" />
              </div>
            ) : null}
          </div>
          {/* Margin comments */}
          {options.showComments && options.commentPlacement === "margin" ? (
            <div className="relative ml-3 w-56 shrink-0" style={{ height: gridHeight }}>
              {visible
                .filter((it) => it.note && it.start != null)
                .map((it) => (
                  <div
                    key={it.id}
                    className="absolute inset-x-0"
                    style={{
                      top: (((it.start ?? 0) - at(options.startHour)) / HOUR) * options.hourHeight,
                    }}
                  >
                    <CommentChip item={it} onOpen={() => openItem(it.id)} />
                  </div>
                ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );

  return (
    <div
      data-slot="calendar-page-prototype"
      className="flex h-dvh w-full overflow-hidden bg-[var(--surface-base)] text-[var(--content-default)]"
    >
      <AnimatedRightDrawer
        key={options.drawerWidth}
        open={open != null}
        left={page}
        right={
          open ? (
            <EventThread
              item={open}
              pending={pendingId === open.id}
              onSend={(text) => send(open.id, text)}
              onClose={() => setOpenId(null)}
              options={options}
            />
          ) : null
        }
        defaultWidth={options.drawerWidth}
        minWidth={320}
        minLeftWidth={480}
      />
      <Tooltip content="Calendars: work, personal, family">
        <span className="sr-only">Calendar legend</span>
      </Tooltip>
    </div>
  );
}
