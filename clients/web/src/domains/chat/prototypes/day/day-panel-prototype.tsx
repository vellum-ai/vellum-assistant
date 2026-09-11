/**
 * Design prototype: what stands in the left panel instead of the recent
 * conversations list.
 *
 * Five arrangements of the same day, switched by `panelMode`:
 *
 * - `recents`: the shipped flat list, kept as the control.
 * - `timeline`: the same list grouped by day, with the past folded.
 * - `loops`: open loops. Work in flight, things waiting on the user, done.
 * - `agenda`: today in time order. Events across calendars, planned blocks,
 *   reminders, and the assistant's notes on them.
 * - `combined`: agenda on top, needs-you pulled out, done folded away.
 *
 * Selecting an item opens its thread on the right, so any event, block, or
 * task is one click from a conversation about it. Everything is prototype
 * state; nothing is wired to the daemon.
 */

/* eslint-disable local/no-untranslated-strings -- design prototype rendered
   only in Storybook; its copy is fixture text, not shipped UI. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bell,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDashed,
  Clock,
  ListChecks,
  MapPin,
  MessageSquare,
  Plus,
  Sparkles,
  Square,
} from "lucide-react";

import { Button, MarkdownMessage, SideMenu, Tooltip } from "@vellumai/design-library";

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
  ThinkingRow,
  authorName,
  clock,
  relative,
} from "../threaded-chat/threaded-chat-prototype";
import { DEFAULT_THREADED_CHAT_OPTIONS } from "../threaded-chat/threaded-chat-prototype";
import {
  CALENDAR_LABELS,
  DAY_SEED,
  at,
  type AgendaItem,
  type AgendaStatus,
  type CalendarKey,
  type DaySeed,
  type NoteTone,
  type RecentConversation,
} from "./day-fixtures";

// ---------------------------------------------------------------------------
// Options (the Storybook knobs)
// ---------------------------------------------------------------------------

export type PanelMode = "recents" | "timeline" | "loops" | "agenda" | "combined";

export interface DayPanelOptions {
  panelMode: PanelMode;
  /** The hour "now" sits at, so the past and future of the day can be moved. */
  nowHour: number;
  /** Show the assistant's note under items it has something to say about. */
  showAssistantNotes: boolean;
  /** On planned blocks, show what the assistant recorded actually happened. */
  showActual: boolean;
  /** How items earlier than now are drawn. */
  pastTreatment: "fade" | "collapse" | "show";
  /** Pull things waiting on the user to the top of the panel. */
  needsYouFirst: boolean;
  /** Keep a "Done today" fold at the bottom. */
  showDoneToday: boolean;
  /** Colour the calendar an event belongs to. */
  calendarColors: boolean;
  density: "comfortable" | "compact";
  panelWidth: number;
  /** Timeline mode: how many day groups stay open. */
  timelineOpenGroups: number;
}

export const DEFAULT_DAY_PANEL_OPTIONS: DayPanelOptions = {
  panelMode: "agenda",
  nowHour: 15.5,
  showAssistantNotes: true,
  showActual: true,
  pastTreatment: "fade",
  needsYouFirst: true,
  showDoneToday: true,
  calendarColors: true,
  density: "comfortable",
  panelWidth: 320,
  timelineOpenGroups: 1,
};

export interface DayPanelPrototypeProps extends DayPanelOptions {
  seed?: DaySeed;
  /** Item to open on mount. */
  initialSelectedId?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MIN = 60_000;
const HOUR = 60 * MIN;

function shortClock(ms: number): string {
  return clock(ms).replace(/ (AM|PM)$/, "");
}

function timeRange(item: AgendaItem): string | null {
  if (item.start == null) {
    return null;
  }
  if (item.end == null) {
    return clock(item.start);
  }
  return `${shortClock(item.start)} to ${clock(item.end)}`;
}

/** Calendar colours read from the palette tokens, not raw hex. */
const CALENDAR_COLOR: Record<CalendarKey, string> = {
  work: "var(--accent-purple-strong)",
  personal: "var(--system-positive-strong)",
  family: "var(--accent-orange-strong)",
};

function NoteIcon({ tone }: { tone: NoteTone }) {
  if (tone === "warn") {
    return <AlertTriangle className="size-3 shrink-0 text-[var(--accent-orange-strong)]" />;
  }
  if (tone === "ready") {
    return <Sparkles className="size-3 shrink-0 text-[var(--accent-purple-strong)]" />;
  }
  return <Sparkles className="size-3 shrink-0 text-[var(--content-tertiary)]" />;
}

function KindIcon({ item, className }: { item: AgendaItem; className?: string }) {
  const cls = cn("size-3.5 shrink-0", className);
  switch (item.kind) {
    case "event":
      return <CalendarDays className={cls} />;
    case "block":
      return <Square className={cls} strokeDasharray="3 2" />;
    case "reminder":
      return <Bell className={cls} />;
    case "task":
    default:
      return <ListChecks className={cls} />;
  }
}

function StatusGlyph({ status }: { status: AgendaStatus }) {
  switch (status) {
    case "done":
      return <CheckCircle2 className="size-3.5 shrink-0 text-[var(--system-positive-strong)]" />;
    case "running":
      return <CircleDashed className="size-3.5 shrink-0 animate-spin text-[var(--accent-purple-strong)] [animation-duration:3s]" />;
    case "waiting-on-you":
      return <AlertTriangle className="size-3.5 shrink-0 text-[var(--accent-orange-strong)]" />;
    case "missed":
      return <Circle className="size-3.5 shrink-0 text-[var(--content-disabled)]" />;
    case "planned":
    default:
      return <Circle className="size-3.5 shrink-0 text-[var(--content-faint)]" />;
  }
}

function statusLabel(status: AgendaStatus): string {
  switch (status) {
    case "done":
      return "Done";
    case "running":
      return "In progress";
    case "waiting-on-you":
      return "Needs you";
    case "missed":
      return "Missed";
    case "planned":
    default:
      return "Planned";
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * @param baseNow Where the knob puts "now". Sends push the clock forward
 *   from there by a few seconds each, so new replies stay in order.
 */
function useDay(seed: DaySeed, baseNow: number) {
  const [items, setItems] = useState<AgendaItem[]>(seed.items);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const clockNow = baseNow + offset;
  const replyIndex = useRef(0);

  const toggleDone = useCallback((id: string) => {
    setItems((prev) =>
      prev.map((it) =>
        it.id === id
          ? { ...it, status: it.status === "done" ? "planned" : "done" }
          : it,
      ),
    );
  }, []);

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
          const message: ProtoMessage = {
            id: `${id}-${atMs}`,
            author,
            text,
            at: atMs,
          };
          const thread: ProtoThread = it.thread
            ? { ...it.thread, replies: [...it.thread.replies, message], unread: 0 }
            : {
                conversationId: `thread-${id}`,
                parentMessageId: id,
                replies: [message],
                unread: 0,
              };
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

  return { items, pendingId, clockNow, toggleDone, send, markRead };
}

// ---------------------------------------------------------------------------
// Panel rows
// ---------------------------------------------------------------------------

interface AgendaRowProps {
  item: AgendaItem;
  now: number;
  options: DayPanelOptions;
  selected: boolean;
  onSelect: () => void;
  onToggleDone?: () => void;
  /** Show the time column. Off in the loops list, where time is secondary. */
  showTime?: boolean;
}

/**
 * One item in the panel: time, kind, title, then the assistant's note. Blocks
 * carry the plan-vs-actual bar. Past items fade; the item under "now" is
 * emphasised.
 */
function AgendaRow({
  item,
  now,
  options,
  selected,
  onSelect,
  onToggleDone,
  showTime = true,
}: AgendaRowProps) {
  const compact = options.density === "compact";
  const isPast = item.end != null ? item.end <= now : item.start != null && item.start <= now && item.kind !== "task";
  const isCurrent =
    item.start != null && item.end != null && item.start <= now && now < item.end;
  const unread = (item.thread?.unread ?? 0) > 0;
  const faded = isPast && options.pastTreatment === "fade" && item.status !== "waiting-on-you";
  const calendarColor =
    options.calendarColors && item.calendar ? CALENDAR_COLOR[item.calendar] : null;
  const canComplete = onToggleDone && (item.kind === "task" || item.kind === "reminder" || item.kind === "block");

  return (
    <li className="list-none">
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect();
          }
        }}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "group/row relative flex w-full gap-2 rounded-md text-left transition-colors",
          compact ? "px-1.5 py-1" : "px-2 py-1.5",
          selected
            ? "bg-[var(--surface-active)]"
            : "hover:bg-[var(--surface-hover)]",
          faded && !selected && "opacity-55 hover:opacity-100",
        )}
      >
        {showTime ? (
          <div
            className={cn(
              "w-9 shrink-0 pt-0.5 text-right tabular-nums",
              "text-label-medium-default",
              isCurrent
                ? "font-medium text-[var(--content-default)]"
                : "text-[var(--content-tertiary)]",
            )}
          >
            {item.start != null ? shortClock(item.start) : ""}
          </div>
        ) : null}
        <div
          className="w-0.5 shrink-0 self-stretch rounded-full"
          style={{
            background: calendarColor ?? "var(--border-subtle)",
            opacity: calendarColor ? 1 : 0.9,
          }}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {canComplete ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleDone?.();
                }}
                aria-label={item.status === "done" ? "Mark not done" : "Mark done"}
                className="shrink-0 rounded-sm text-[var(--content-faint)] hover:text-[var(--content-default)]"
              >
                {item.status === "done" ? (
                  <CheckCircle2 className="size-3.5 text-[var(--system-positive-strong)]" />
                ) : (
                  <Circle className="size-3.5" />
                )}
              </button>
            ) : (
              <KindIcon
                item={item}
                className={cn(
                  item.status === "done"
                    ? "text-[var(--content-faint)]"
                    : "text-[var(--content-tertiary)]",
                )}
              />
            )}
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-body-medium-default",
                item.status === "done" && item.kind !== "event"
                  ? "font-normal text-[var(--content-secondary)] line-through decoration-[var(--content-faint)]"
                  : unread || isCurrent
                    ? "text-[var(--content-default)]"
                    : "font-normal text-[var(--content-default)]",
              )}
            >
              {item.title}
            </span>
            {unread ? (
              <span
                className="size-1.5 shrink-0 rounded-full bg-[var(--accent-orange-strong)]"
                aria-label="Unread"
              />
            ) : item.thread ? (
              <MessageSquare className="size-3 shrink-0 text-[var(--content-faint)] opacity-0 group-hover/row:opacity-100" />
            ) : null}
          </div>
          {item.location && !compact ? (
            <div className="mt-0.5 flex items-center gap-1 text-label-medium-default text-[var(--content-tertiary)]">
              <MapPin className="size-3" />
              <span className="truncate">{item.location}</span>
            </div>
          ) : null}
          {options.showAssistantNotes && item.note ? (
            <div
              className={cn(
                "mt-1 flex items-start gap-1.5 text-body-small-default leading-4",
                item.note.tone === "warn"
                  ? "text-[var(--content-default)]"
                  : "text-[var(--content-secondary)]",
              )}
            >
              <span className="pt-0.5">
                <NoteIcon tone={item.note.tone} />
              </span>
              <span className={cn(compact ? "line-clamp-1" : "line-clamp-2")}>
                {item.note.text}
              </span>
            </div>
          ) : null}
          {options.showActual && item.kind === "block" && item.actual ? (
            <ActualBar item={item} compact={compact} />
          ) : null}
        </div>
      </div>
    </li>
  );
}

/** Plan vs actual on a block: how much of it went to the plan. */
function ActualBar({ item, compact }: { item: AgendaItem; compact: boolean }) {
  const actual = item.actual;
  if (!actual || item.start == null || item.end == null) {
    return null;
  }
  const planned = (item.end - item.start) / MIN;
  const on = Math.min(1, actual.onPlanMinutes / planned);
  const off = Math.min(1 - on, actual.offPlanMinutes / planned);
  return (
    <div className="mt-1.5">
      <div
        className="flex h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-sunken)] ring-1 ring-inset ring-[var(--border-subtle)]"
        aria-label={`${actual.onPlanMinutes} of ${planned} minutes on plan`}
      >
        <div
          className="h-full bg-[var(--system-positive-strong)]"
          style={{ width: `${on * 100}%` }}
        />
        <div
          className="h-full bg-[var(--accent-orange-strong)] opacity-70"
          style={{ width: `${off * 100}%` }}
        />
      </div>
      {!compact ? (
        <p className="mt-1 line-clamp-2 text-label-medium-default leading-4 text-[var(--content-tertiary)]">
          {actual.summary}
        </p>
      ) : null}
    </div>
  );
}

function NowLine({ label }: { label: string }) {
  return (
    <li className="my-1 flex items-center gap-2 pl-1 pr-2" aria-label="Now">
      <span className="w-9 shrink-0 text-right text-label-small-default font-medium tabular-nums text-[var(--accent-orange-strong)]">
        {label}
      </span>
      <span className="size-1.5 shrink-0 rounded-full bg-[var(--accent-orange-strong)]" />
      <span className="h-px flex-1 bg-[var(--accent-orange-strong)] opacity-60" />
    </li>
  );
}

/** A collapsible group in the panel with a count. */
function Group({
  title,
  count,
  open,
  onToggle,
  children,
  icon,
  muted,
}: {
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  icon?: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          "flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-label-medium-default uppercase tracking-wide hover:bg-[var(--surface-hover)]",
          muted ? "text-[var(--content-faint)]" : "text-[var(--content-tertiary)]",
        )}
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {icon}
        <span className="flex-1">{title}</span>
        {count != null ? <span className="tabular-nums">{count}</span> : null}
      </button>
      {open ? <ul className="m-0 flex list-none flex-col gap-0.5 p-0">{children}</ul> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel modes
// ---------------------------------------------------------------------------

interface PanelBodyProps {
  items: AgendaItem[];
  recents: RecentConversation[];
  now: number;
  options: DayPanelOptions;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggleDone: (id: string) => void;
}

/** The shipped list, as a control. */
function RecentsPanel({ recents, selectedId, onSelect }: PanelBodyProps) {
  return (
    <SideMenu.Section title="Chats">
      <SideMenu.SubList>
        {recents.map((c) => (
          <li key={c.id}>
            <SideMenu.Item
              label={c.title}
              active={selectedId === c.id}
              onSelect={() => onSelect(c.id)}
              badge={
                c.unread ? (
                  <span className="size-1.5 rounded-full bg-[var(--accent-orange-strong)]" />
                ) : undefined
              }
            />
          </li>
        ))}
      </SideMenu.SubList>
    </SideMenu.Section>
  );
}

function dayGroupLabel(msAgo: number): string {
  if (msAgo < 24 * HOUR) {
    return "Today";
  }
  if (msAgo < 48 * HOUR) {
    return "Yesterday";
  }
  if (msAgo < 7 * 24 * HOUR) {
    return "This week";
  }
  return "Earlier";
}

/** The same list, by day, with the past folded. */
function TimelinePanel({ recents, now, options, selectedId, onSelect }: PanelBodyProps) {
  const groups = useMemo(() => {
    const order = ["Today", "Yesterday", "This week", "Earlier"];
    const by = new Map<string, RecentConversation[]>();
    for (const c of recents) {
      const label = dayGroupLabel(now - c.at);
      by.set(label, [...(by.get(label) ?? []), c]);
    }
    return order.filter((l) => by.has(l)).map((l) => ({ label: l, items: by.get(l) ?? [] }));
  }, [recents, now]);
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(groups.map((g, i) => [g.label, i < options.timelineOpenGroups])),
  );
  return (
    <div className="flex flex-col gap-2">
      {groups.map((g) => (
        <Group
          key={g.label}
          title={g.label}
          count={g.items.length}
          open={open[g.label] ?? false}
          onToggle={() => setOpen((p) => ({ ...p, [g.label]: !p[g.label] }))}
          muted={g.label === "Earlier"}
        >
          {g.items.map((c) => (
            <li key={c.id}>
              <SideMenu.Item
                label={c.title}
                active={selectedId === c.id}
                onSelect={() => onSelect(c.id)}
                size={options.density === "compact" ? "compact" : "default"}
                badge={
                  <span className="flex items-center gap-1.5 text-label-medium-default text-[var(--content-faint)]">
                    {c.unread ? (
                      <span className="size-1.5 rounded-full bg-[var(--accent-orange-strong)]" />
                    ) : null}
                    {g.label === "Today" ? shortClock(c.at) : ""}
                  </span>
                }
              />
            </li>
          ))}
        </Group>
      ))}
    </div>
  );
}

/** Open loops: what is in flight, what needs the user, what got done. */
function LoopsPanel({ items, now, options, selectedId, onSelect, onToggleDone }: PanelBodyProps) {
  const loops = items.filter((it) => it.kind !== "event");
  const needsYou = loops.filter((it) => it.status === "waiting-on-you");
  const running = loops.filter((it) => it.status === "running");
  const planned = loops.filter((it) => it.status === "planned");
  const done = loops.filter((it) => it.status === "done");
  const [doneOpen, setDoneOpen] = useState(false);
  const row = (it: AgendaItem) => (
    <AgendaRow
      key={it.id}
      item={it}
      now={now}
      options={{ ...options, pastTreatment: "show" }}
      selected={selectedId === it.id}
      onSelect={() => onSelect(it.id)}
      onToggleDone={() => onToggleDone(it.id)}
      showTime={false}
    />
  );
  const section = (title: string, list: AgendaItem[], icon?: React.ReactNode) =>
    list.length ? (
      <div className="flex flex-col gap-0.5">
        <div className="flex h-7 items-center gap-1.5 px-1.5 text-label-medium-default uppercase tracking-wide text-[var(--content-tertiary)]">
          {icon}
          <span className="flex-1">{title}</span>
          <span className="tabular-nums">{list.length}</span>
        </div>
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">{list.map(row)}</ul>
      </div>
    ) : null;
  return (
    <div className="flex flex-col gap-3">
      {options.needsYouFirst ? section("Needs you", needsYou, <AlertTriangle className="size-3 text-[var(--accent-orange-strong)]" />) : null}
      {section("In progress", running, <CircleDashed className="size-3" />)}
      {section("Up next", planned, <Clock className="size-3" />)}
      {!options.needsYouFirst ? section("Needs you", needsYou) : null}
      {options.showDoneToday && done.length ? (
        <Group
          title="Done today"
          count={done.length}
          open={doneOpen}
          onToggle={() => setDoneOpen((o) => !o)}
          icon={<Check className="size-3" />}
          muted
        >
          {done.map(row)}
        </Group>
      ) : null}
    </div>
  );
}

/** Today in time order, with a now line. */
function AgendaPanel({ items, now, options, selectedId, onSelect, onToggleDone }: PanelBodyProps) {
  const timed = items
    .filter((it) => it.start != null)
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const floating = items.filter((it) => it.start == null);
  const past = timed.filter((it) => (it.end ?? it.start ?? 0) <= now);
  const upcoming = timed.filter((it) => (it.end ?? it.start ?? 0) > now);
  const [pastOpen, setPastOpen] = useState(options.pastTreatment !== "collapse");
  const row = (it: AgendaItem) => (
    <AgendaRow
      key={it.id}
      item={it}
      now={now}
      options={options}
      selected={selectedId === it.id}
      onSelect={() => onSelect(it.id)}
      onToggleDone={() => onToggleDone(it.id)}
    />
  );
  const nowLabel = shortClock(now);
  return (
    <div className="flex flex-col gap-1">
      {options.pastTreatment === "collapse" ? (
        <Group
          title="Earlier today"
          count={past.length}
          open={pastOpen}
          onToggle={() => setPastOpen((o) => !o)}
          muted
        >
          {past.map(row)}
        </Group>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">{past.map(row)}</ul>
      )}
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        <NowLine label={nowLabel} />
        {upcoming.map(row)}
      </ul>
      {floating.length ? (
        <div className="mt-2 flex flex-col gap-0.5">
          <div className="flex h-7 items-center gap-1.5 px-1.5 text-label-medium-default uppercase tracking-wide text-[var(--content-tertiary)]">
            <ListChecks className="size-3" />
            <span className="flex-1">Anytime</span>
            <span className="tabular-nums">{floating.length}</span>
          </div>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {floating.map((it) => (
              <AgendaRow
                key={it.id}
                item={it}
                now={now}
                options={options}
                selected={selectedId === it.id}
                onSelect={() => onSelect(it.id)}
                onToggleDone={() => onToggleDone(it.id)}
                showTime={false}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Agenda, with needs-you pulled out on top and done folded at the bottom. */
function CombinedPanel(props: PanelBodyProps) {
  const { items, now, options, selectedId, onSelect, onToggleDone } = props;
  const needsYou = items.filter((it) => it.status === "waiting-on-you");
  const done = items.filter((it) => it.status === "done" && it.kind !== "event");
  const rest = items.filter(
    (it) => it.status !== "waiting-on-you" && !(it.status === "done" && it.kind !== "event"),
  );
  const [doneOpen, setDoneOpen] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      {options.needsYouFirst && needsYou.length ? (
        <div className="flex flex-col gap-0.5">
          <div className="flex h-7 items-center gap-1.5 px-1.5 text-label-medium-default uppercase tracking-wide text-[var(--content-tertiary)]">
            <AlertTriangle className="size-3 text-[var(--accent-orange-strong)]" />
            <span className="flex-1">Needs you</span>
            <span className="tabular-nums">{needsYou.length}</span>
          </div>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {needsYou.map((it) => (
              <AgendaRow
                key={it.id}
                item={it}
                now={now}
                options={options}
                selected={selectedId === it.id}
                onSelect={() => onSelect(it.id)}
                onToggleDone={() => onToggleDone(it.id)}
                showTime={false}
              />
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex flex-col gap-0.5">
        <div className="flex h-7 items-center gap-1.5 px-1.5 text-label-medium-default uppercase tracking-wide text-[var(--content-tertiary)]">
          <CalendarDays className="size-3" />
          <span className="flex-1">Today</span>
        </div>
        <AgendaPanel {...props} items={rest} />
      </div>
      {options.showDoneToday && done.length ? (
        <Group
          title="Done today"
          count={done.length}
          open={doneOpen}
          onToggle={() => setDoneOpen((o) => !o)}
          icon={<Check className="size-3" />}
          muted
        >
          {done.map((it) => (
            <AgendaRow
              key={it.id}
              item={it}
              now={now}
              options={{ ...options, pastTreatment: "show" }}
              selected={selectedId === it.id}
              onSelect={() => onSelect(it.id)}
              onToggleDone={() => onToggleDone(it.id)}
              showTime={false}
            />
          ))}
        </Group>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right pane: the selected item and its thread
// ---------------------------------------------------------------------------

function ItemPane({
  item,
  now,
  pending,
  onSend,
  options,
}: {
  item: AgendaItem;
  now: number;
  pending: boolean;
  onSend: (text: string) => void;
  options: DayPanelOptions;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const count = item.thread?.replies.length ?? 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [count, pending]);
  const range = timeRange(item);
  const calendarColor =
    options.calendarColors && item.calendar ? CALENDAR_COLOR[item.calendar] : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[var(--border-subtle)] px-6 pb-4 pt-5">
        <div className="mx-auto w-full max-w-[720px]">
          <div className="flex items-center gap-2 text-label-medium-default uppercase tracking-wide text-[var(--content-tertiary)]">
            <KindIcon item={item} />
            <span>{item.kind === "block" ? "Time block" : item.kind}</span>
            {item.calendar ? (
              <span className="flex items-center gap-1 normal-case tracking-normal">
                <span
                  className="size-2 rounded-full"
                  style={{ background: calendarColor ?? "var(--content-faint)" }}
                />
                {CALENDAR_LABELS[item.calendar]}
              </span>
            ) : null}
            <span className="ml-auto flex items-center gap-1 normal-case tracking-normal">
              <StatusGlyph status={item.status} />
              {statusLabel(item.status)}
            </span>
          </div>
          <h1 className="mt-1.5 text-title-medium text-[var(--content-default)]">
            {item.title}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-body-small-default text-[var(--content-secondary)]">
            {range ? (
              <span className="flex items-center gap-1">
                <Clock className="size-3.5" /> {range}
              </span>
            ) : null}
            {item.location ? (
              <span className="flex items-center gap-1">
                <MapPin className="size-3.5" /> {item.location}
              </span>
            ) : null}
          </div>
          {item.note ? (
            <div
              className={cn(
                "mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-body-medium-default font-normal",
                item.note.tone === "warn"
                  ? "bg-[var(--accent-orange-weak)] text-[var(--content-default)]"
                  : "bg-[var(--surface-sunken)] text-[var(--content-default)]",
              )}
            >
              <Avatar author="assistant" size={20} />
              <span>{item.note.text}</span>
            </div>
          ) : null}
          {item.kind === "block" && item.actual && options.showActual ? (
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between text-label-medium-default text-[var(--content-tertiary)]">
                <span>Plan vs actual</span>
                <span className="tabular-nums">
                  {item.actual.onPlanMinutes} min on plan · {item.actual.offPlanMinutes} min elsewhere
                </span>
              </div>
              <ActualBar item={item} compact={false} />
            </div>
          ) : null}
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4">
          {count === 0 && !pending ? (
            <p className="text-body-medium-default font-normal text-[var(--content-tertiary)]">
              Nothing said about this yet. Ask {PROTO_ASSISTANT_NAME} anything about it below.
            </p>
          ) : null}
          {item.thread?.replies.map((reply) =>
            reply.author === "user" ? (
              <div key={reply.id} className="flex justify-end">
                <div className="max-w-[80%] rounded-xl bg-[var(--surface-lift)] px-4 py-3">
                  <MarkdownMessage content={reply.text} className="text-chat [&_p]:my-0" />
                </div>
              </div>
            ) : (
              <div key={reply.id} className="flex gap-3">
                <div className="mt-0.5 shrink-0">
                  <Avatar author="assistant" size={28} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="mb-0.5 flex items-baseline gap-2">
                    <span className="text-body-medium-default">{authorName(reply.author)}</span>
                    <span className="text-label-medium-default text-[var(--content-tertiary)]">
                      {clock(reply.at)} · {relative(reply.at, now)}
                    </span>
                  </div>
                  <MarkdownMessage content={reply.text} className="text-chat [&_p]:my-0" />
                </div>
              </div>
            ),
          )}
          {pending ? (
            <ThinkingRow options={DEFAULT_THREADED_CHAT_OPTIONS} compactGutter={false} />
          ) : null}
        </div>
      </div>

      <div className="shrink-0 px-6 pb-5">
        <div className="mx-auto w-full max-w-[720px]">
          <Composer
            placeholder={`Ask about ${item.title}`}
            onSend={onSend}
            options={DEFAULT_THREADED_CHAT_OPTIONS}
          />
        </div>
      </div>
    </div>
  );
}

function HomePane({ items, now }: { items: AgendaItem[]; now: number }) {
  const needsYou = items.filter((it) => it.status === "waiting-on-you").length;
  const upcoming = items.filter((it) => it.start != null && it.start > now && it.kind === "event").length;
  const done = items.filter((it) => it.status === "done").length;
  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      <div className="w-full max-w-[560px]">
        <div className="flex items-center gap-3">
          <Avatar author="assistant" size={36} />
          <h1 className="text-title-medium text-[var(--content-default)]">
            Good afternoon. Here is where the day stands.
          </h1>
        </div>
        <div className="mt-5 grid grid-cols-3 gap-3">
          {[
            { label: "Needs you", value: needsYou, tone: "warn" },
            { label: "Still today", value: upcoming, tone: "info" },
            { label: "Done", value: done, tone: "ready" },
          ].map((s) => (
            <div
              key={s.label}
              className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-lift)] px-3 py-2.5"
            >
              <div className="text-title-medium tabular-nums text-[var(--content-default)]">
                {s.value}
              </div>
              <div className="mt-1 text-label-medium-default text-[var(--content-tertiary)]">
                {s.label}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-5 text-body-medium-default font-normal text-[var(--content-secondary)]">
          Pick anything on the left to talk about it, or start fresh below.
        </p>
        <div className="mt-4">
          <Composer
            placeholder={`Message ${PROTO_ASSISTANT_NAME}`}
            onSend={() => {}}
            options={DEFAULT_THREADED_CHAT_OPTIONS}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The prototype
// ---------------------------------------------------------------------------

export function DayPanelPrototype({
  seed = DAY_SEED,
  initialSelectedId = null,
  ...options
}: DayPanelPrototypeProps) {
  const { items, pendingId, clockNow, toggleDone, send, markRead } = useDay(
    seed,
    at(options.nowHour),
  );
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  // The knob moves "now"; sends nudge the fixture clock forward from there.
  const now = clockNow;

  const select = useCallback(
    (id: string) => {
      setSelectedId(id);
      markRead(id);
    },
    [markRead],
  );

  const selected = items.find((it) => it.id === selectedId) ?? null;
  const bodyProps: PanelBodyProps = {
    items,
    recents: seed.recents,
    now,
    options,
    selectedId,
    onSelect: select,
    onToggleDone: toggleDone,
  };

  let panelBody: React.ReactNode;
  switch (options.panelMode) {
    case "recents":
      panelBody = <RecentsPanel {...bodyProps} />;
      break;
    case "timeline":
      panelBody = <TimelinePanel {...bodyProps} />;
      break;
    case "loops":
      panelBody = <LoopsPanel {...bodyProps} />;
      break;
    case "combined":
      panelBody = <CombinedPanel {...bodyProps} />;
      break;
    case "agenda":
    default:
      panelBody = <AgendaPanel {...bodyProps} />;
  }

  const dateLabel = new Date(now).toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

  return (
    <div
      data-slot="day-panel-prototype"
      className="flex h-dvh w-full gap-2 overflow-hidden bg-[var(--surface-base)] p-2 text-[var(--content-default)]"
    >
      <SideMenu
        ariaLabel="Day"
        variant="rail"
        collapsed={false}
        width={options.panelWidth}
        className="h-full shrink-0"
      >
        <SideMenu.Header>
          <div className="flex items-center gap-2 px-1">
            <Avatar author="assistant" size={28} />
            <span className="flex-1 text-body-medium-default">{PROTO_ASSISTANT_NAME}</span>
            <Tooltip content="New chat">
              <Button variant="ghost" size="compact" iconOnly={<Plus />} aria-label="New chat" />
            </Tooltip>
          </div>
          {options.panelMode !== "recents" ? (
            <div className="mt-2 flex items-center justify-between px-1.5">
              <span className="text-body-medium-default text-[var(--content-default)]">
                {options.panelMode === "timeline" ? "Chats" : options.panelMode === "loops" ? "Open loops" : dateLabel}
              </span>
              {options.panelMode === "agenda" || options.panelMode === "combined" ? (
                <Tooltip content="Open calendar">
                  <Button variant="ghost" size="compact" iconOnly={<CalendarDays />} aria-label="Open calendar" />
                </Tooltip>
              ) : null}
            </div>
          ) : null}
        </SideMenu.Header>
        <SideMenu.Body>{panelBody}</SideMenu.Body>
        <SideMenu.Footer>
          <SideMenu.Item icon={Circle} label="Preferences" />
        </SideMenu.Footer>
      </SideMenu>
      <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-overlay)]">
        {selected ? (
          <ItemPane
            key={selected.id}
            item={selected}
            now={now}
            pending={pendingId === selected.id}
            onSend={(text) => send(selected.id, text)}
            options={options}
          />
        ) : (
          <HomePane items={items} now={now} />
        )}
      </div>
    </div>
  );
}
