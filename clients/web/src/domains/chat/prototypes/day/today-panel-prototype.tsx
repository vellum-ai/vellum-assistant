/**
 * Design prototype: the left panel as a list that gets shorter.
 *
 * Builds on the by-day timeline, keeping its whole vocabulary (a title, a
 * time chip, a fold with a count) and adding one thing: progression. Today's
 * list holds what is still open. Closing an item takes it off the list and
 * bumps the count on the DONE fold. Three things close items: the user (a
 * check on hover), the assistant (a task it finishes), and the clock (an
 * event whose time has passed). Nothing is added to say any of that; the
 * list just gets shorter.
 *
 * Prototype state only.
 */

/* eslint-disable local/no-untranslated-strings -- design prototype rendered
   only in Storybook; its copy is fixture text, not shipped UI. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, ChevronDown, ChevronRight, Plus } from "lucide-react";

import {
  Button,
  MarkdownMessage,
  SideMenu,
  Tooltip,
} from "@vellumai/design-library";

import { cn } from "@/utils/misc";

import {
  MOCK_REPLIES,
  PROTO_ASSISTANT_NAME,
  type ProtoMessage,
} from "../threaded-chat/fixtures";
import {
  Avatar,
  Composer,
  DEFAULT_THREADED_CHAT_OPTIONS,
  ThinkingRow,
  authorName,
  clock,
} from "../threaded-chat/threaded-chat-prototype";
import { DAY_SEED, at, type DaySeed } from "./day-fixtures";

// ---------------------------------------------------------------------------
// Options (the Storybook knobs)
// ---------------------------------------------------------------------------

export interface TodayPanelOptions {
  /** Where "now" sits. Events before it have passed and leave the list. */
  nowHour: number;
  /** How the user closes an item. */
  closeAffordance: "hover-check" | "chip-check" | "none";
  /** When the time chip shows. */
  timeChip: "always" | "hover" | "none";
  /** How progress reads. `count` is the DONE fold's number; `line` adds a
   *  hairline under TODAY that fills as the day closes out. */
  progress: "count" | "line" | "none";
  /** Where closed items go. */
  done: "fold" | "hidden";
  /** Bold the items that are waiting on the user. The only emphasis. */
  emphasizeNeedsYou: boolean;
  /** A running task shows a quiet pulse in place of its time. */
  showAssistantWorking: boolean;
  /** A running task finishes a few seconds after load and leaves the list. */
  autoCloseDemo: boolean;
  /** The Yesterday / This week / Earlier folds of past chats. */
  pastFolds: boolean;
  density: "comfortable" | "compact";
  panelWidth: number;
}

export const DEFAULT_TODAY_PANEL_OPTIONS: TodayPanelOptions = {
  nowHour: 15.5,
  closeAffordance: "hover-check",
  timeChip: "always",
  progress: "count",
  done: "fold",
  emphasizeNeedsYou: true,
  showAssistantWorking: true,
  autoCloseDemo: true,
  pastFolds: true,
  density: "comfortable",
  panelWidth: 300,
};

export interface TodayPanelPrototypeProps extends TodayPanelOptions {
  seed?: DaySeed;
  initialSelectedId?: string | null;
}

// ---------------------------------------------------------------------------
// Model: one flat shape for chats, tasks, and events
// ---------------------------------------------------------------------------

type ItemState = "open" | "running" | "needs-you" | "done";

interface TodayItem {
  id: string;
  title: string;
  /** Epoch ms; undefined for things with no time. */
  time?: number;
  /** Timed items with an end pass off the list once it is behind now. */
  end?: number;
  state: ItemState;
  messages: ProtoMessage[];
}

const HOUR = 3_600_000;

function fromSeed(seed: DaySeed): TodayItem[] {
  return seed.items.map((it) => ({
    id: it.id,
    title: it.title,
    time: it.start,
    end: it.end,
    state:
      it.status === "done"
        ? "done"
        : it.status === "running"
          ? "running"
          : it.status === "waiting-on-you"
            ? "needs-you"
            : "open",
    messages: it.thread?.replies ?? [],
  }));
}

function shortClock(ms: number): string {
  return clock(ms).replace(/ (AM|PM)$/, "");
}

/** Whether the clock has closed a timed item. */
function passed(item: TodayItem, now: number): boolean {
  const endsAt = item.end ?? item.time;
  return endsAt != null && endsAt <= now;
}

function dayGroup(msAgo: number): "Yesterday" | "This week" | "Earlier" {
  if (msAgo < 48 * HOUR) {
    return "Yesterday";
  }
  if (msAgo < 7 * 24 * HOUR) {
    return "This week";
  }
  return "Earlier";
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function useToday(seed: DaySeed, baseNow: number, autoCloseDemo: boolean) {
  const [items, setItems] = useState<TodayItem[]>(() => fromSeed(seed));
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const now = baseNow + offset;
  const replyIndex = useRef(0);

  const setState = useCallback((id: string, state: ItemState) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, state } : it)));
  }, []);

  const close = useCallback((id: string) => setState(id, "done"), [setState]);
  const reopen = useCallback((id: string) => setState(id, "open"), [setState]);

  // The assistant finishing something: the running item closes on its own.
  useEffect(() => {
    if (!autoCloseDemo) {
      return;
    }
    const running = items.find((it) => it.state === "running");
    if (!running) {
      return;
    }
    const timer = window.setTimeout(() => close(running.id), 4500);
    return () => window.clearTimeout(timer);
    // Only the first running item on load; a later state change should not
    // restart the clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCloseDemo]);

  const append = useCallback(
    (id: string, author: ProtoMessage["author"], text: string) => {
      const step = author === "user" ? 15_000 : 30_000;
      const atMs = now + step;
      setOffset((o) => o + step);
      setItems((prev) =>
        prev.map((it) =>
          it.id === id
            ? {
                ...it,
                messages: [
                  ...it.messages,
                  { id: `${id}-${atMs}`, author, text, at: atMs },
                ],
              }
            : it,
        ),
      );
    },
    [now],
  );

  const send = useCallback(
    (id: string, text: string) => {
      append(id, "user", text);
      setPendingId(id);
    },
    [append],
  );

  useEffect(() => {
    if (pendingId == null) {
      return;
    }
    const timer = window.setTimeout(() => {
      const text = MOCK_REPLIES[replyIndex.current % MOCK_REPLIES.length];
      replyIndex.current += 1;
      append(pendingId, "assistant", text);
      setPendingId(null);
    }, 1100);
    return () => window.clearTimeout(timer);
  }, [pendingId, append]);

  return { items, now, pendingId, close, reopen, send };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function Fold({
  title,
  count,
  open,
  onToggle,
  children,
  muted,
  progress,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
  muted?: boolean;
  /** 0..1 fills a hairline under the header. */
  progress?: number;
}) {
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          "flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-label-medium-default uppercase tracking-wide",
          muted ? "text-[var(--content-faint)]" : "text-[var(--content-tertiary)]",
          "hover:bg-[var(--surface-hover)]",
        )}
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <span className="flex-1">{title}</span>
        <span className="tabular-nums">{count}</span>
      </button>
      {progress != null ? (
        <div className="mx-1.5 mb-1 h-px bg-[var(--border-subtle)]">
          <motion.div
            className="h-px bg-[var(--content-tertiary)]"
            initial={false}
            animate={{ width: `${Math.round(progress * 100)}%` }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          />
        </div>
      ) : null}
      {open ? children : null}
    </div>
  );
}

function Row({
  item,
  options,
  selected,
  onSelect,
  onClose,
  onReopen,
}: {
  item: TodayItem;
  options: TodayPanelOptions;
  selected: boolean;
  onSelect: () => void;
  onClose: () => void;
  onReopen: () => void;
}) {
  const reduce = useReducedMotion();
  const isDone = item.state === "done";
  const running = item.state === "running" && options.showAssistantWorking;
  const needsYou = item.state === "needs-you" && options.emphasizeNeedsYou;
  const canClose = options.closeAffordance !== "none";
  const chipCheck = canClose && options.closeAffordance === "chip-check";
  const showChip = item.time != null && options.timeChip !== "none" && !running;

  // The badge slot is the design library's pill, so it carries only text. On
  // hover the pill either slides left to make room for the check
  // (hover-check) or fades so the check takes its place (chip-check).
  const badge = running ? (
    <span
      className="mx-0.5 my-1 block size-1.5 rounded-full bg-[var(--content-tertiary)] motion-safe:animate-pulse"
      aria-label={`${PROTO_ASSISTANT_NAME} is working`}
    />
  ) : showChip && item.time != null ? (
    <span
      className={cn(
        "tabular-nums transition-[opacity,margin]",
        options.timeChip === "hover" && "opacity-0 group-hover/row:opacity-100",
        canClose && (chipCheck ? "group-hover/row:opacity-0" : "group-hover/row:mr-5"),
      )}
    >
      {shortClock(item.time)}
    </span>
  ) : undefined;

  return (
    <motion.li
      layout={!reduce}
      initial={false}
      exit={{ opacity: 0, height: 0, marginTop: 0 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      className="group/row relative list-none overflow-hidden"
    >
      <SideMenu.Item
        label={item.title}
        active={selected}
        onSelect={onSelect}
        size={options.density === "compact" ? "compact" : "default"}
        emphasized={needsYou}
        className={cn(isDone && "text-[var(--content-tertiary)]")}
        badge={badge}
      />
      {canClose ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            if (isDone) {
              onReopen();
            } else {
              onClose();
            }
          }}
          aria-label={isDone ? "Reopen" : "Done"}
          className={cn(
            "absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-[var(--content-tertiary)] opacity-0 transition-opacity",
            "hover:bg-[var(--surface-active)] hover:text-[var(--content-default)]",
            "group-hover/row:opacity-100 focus-visible:opacity-100",
          )}
        >
          <Check className="size-3.5" />
        </button>
      ) : null}
    </motion.li>
  );
}

// ---------------------------------------------------------------------------
// Right pane: the item's thread, and nothing else
// ---------------------------------------------------------------------------

function Pane({
  item,
  pending,
  onSend,
}: {
  item: TodayItem;
  pending: boolean;
  onSend: (text: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const count = item.messages.length;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [count, pending]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center px-6">
        <span className="text-body-medium-default">{item.title}</span>
        {item.time != null ? (
          <span className="ml-2 text-body-small-default text-[var(--content-tertiary)]">
            {clock(item.time)}
          </span>
        ) : null}
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 py-2">
          {item.messages.map((m) =>
            m.author === "user" ? (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[80%] rounded-xl bg-[var(--surface-lift)] px-4 py-3">
                  <MarkdownMessage content={m.text} className="text-chat [&_p]:my-0" />
                </div>
              </div>
            ) : (
              <div key={m.id} className="flex gap-3">
                <div className="mt-0.5 shrink-0">
                  <Avatar author="assistant" size={28} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="mb-0.5 flex items-baseline gap-2">
                    <span className="text-body-medium-default">{authorName(m.author)}</span>
                    <span className="text-label-medium-default text-[var(--content-tertiary)]">
                      {clock(m.at)}
                    </span>
                  </div>
                  <MarkdownMessage content={m.text} className="text-chat [&_p]:my-0" />
                </div>
              </div>
            ),
          )}
          {pending ? <ThinkingRow options={DEFAULT_THREADED_CHAT_OPTIONS} compactGutter={false} /> : null}
        </div>
      </div>
      <div className="shrink-0 px-6 pb-5">
        <div className="mx-auto w-full max-w-[720px]">
          <Composer
            placeholder={`Message ${PROTO_ASSISTANT_NAME}`}
            onSend={onSend}
            options={DEFAULT_THREADED_CHAT_OPTIONS}
          />
        </div>
      </div>
    </div>
  );
}

function EmptyPane() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      <div className="w-full max-w-[560px]">
        <Composer
          placeholder={`Message ${PROTO_ASSISTANT_NAME}`}
          onSend={() => {}}
          options={DEFAULT_THREADED_CHAT_OPTIONS}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The prototype
// ---------------------------------------------------------------------------

export function TodayPanelPrototype({
  seed = DAY_SEED,
  initialSelectedId = null,
  ...options
}: TodayPanelPrototypeProps) {
  const { items, now, pendingId, close, reopen, send } = useToday(
    seed,
    at(options.nowHour),
    options.autoCloseDemo,
  );
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const [doneOpen, setDoneOpen] = useState(false);
  const [foldsOpen, setFoldsOpen] = useState<Record<string, boolean>>({});

  // Open: not done, and not closed by the clock. Ordered by time, untimed
  // last. Done: everything else from today.
  const open = useMemo(
    () =>
      items
        .filter((it) => it.state !== "done" && !passed(it, now))
        .sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity)),
    [items, now],
  );
  const done = useMemo(
    () => items.filter((it) => it.state === "done" || passed(it, now)),
    [items, now],
  );
  const total = items.length;
  const progress = total ? done.length / total : 0;

  const past = useMemo(() => {
    const groups = new Map<string, DaySeed["recents"]>();
    for (const c of seed.recents) {
      const msAgo = now - c.at;
      if (msAgo < 24 * HOUR) {
        continue;
      }
      const label = dayGroup(msAgo);
      groups.set(label, [...(groups.get(label) ?? []), c]);
    }
    return (["Yesterday", "This week", "Earlier"] as const)
      .filter((l) => groups.has(l))
      .map((l) => ({ label: l, items: groups.get(l) ?? [] }));
  }, [seed.recents, now]);

  const selected = items.find((it) => it.id === selectedId) ?? null;

  const row = (it: TodayItem) => (
    <Row
      key={it.id}
      item={it}
      options={options}
      selected={selectedId === it.id}
      onSelect={() => setSelectedId(it.id)}
      onClose={() => close(it.id)}
      onReopen={() => reopen(it.id)}
    />
  );

  return (
    <div
      data-slot="today-panel-prototype"
      className="flex h-dvh w-full gap-2 overflow-hidden bg-[var(--surface-base)] p-2 text-[var(--content-default)]"
    >
      <SideMenu
        ariaLabel="Today"
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
        </SideMenu.Header>
        <SideMenu.Body>
          <div className="flex flex-col gap-1">
            <Fold
              title="Today"
              count={open.length}
              open
              onToggle={() => {}}
              progress={options.progress === "line" ? progress : undefined}
            >
              <ul className="m-0 flex flex-col gap-0.5 p-0">
                <AnimatePresence initial={false}>{open.map(row)}</AnimatePresence>
              </ul>
              {open.length === 0 ? (
                <p className="px-2 py-1.5 text-body-small-default text-[var(--content-tertiary)]">
                  Nothing open.
                </p>
              ) : null}
            </Fold>
            {options.done === "fold" ? (
              <Fold
                title="Done"
                count={done.length}
                open={doneOpen}
                onToggle={() => setDoneOpen((o) => !o)}
                muted
              >
                <ul className="m-0 flex flex-col gap-0.5 p-0">
                  <AnimatePresence initial={false}>{done.map(row)}</AnimatePresence>
                </ul>
              </Fold>
            ) : null}
            {options.pastFolds
              ? past.map((g) => (
                  <Fold
                    key={g.label}
                    title={g.label}
                    count={g.items.length}
                    open={foldsOpen[g.label] ?? false}
                    onToggle={() => setFoldsOpen((p) => ({ ...p, [g.label]: !p[g.label] }))}
                    muted={g.label === "Earlier"}
                  >
                    <ul className="m-0 flex flex-col gap-0.5 p-0">
                      {g.items.map((c) => (
                        <li key={c.id} className="list-none">
                          <SideMenu.Item
                            label={c.title}
                            size={options.density === "compact" ? "compact" : "default"}
                            active={selectedId === c.id}
                            onSelect={() => setSelectedId(c.id)}
                          />
                        </li>
                      ))}
                    </ul>
                  </Fold>
                ))
              : null}
          </div>
        </SideMenu.Body>
      </SideMenu>
      <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-overlay)]">
        {selected ? (
          <Pane
            key={selected.id}
            item={selected}
            pending={pendingId === selected.id}
            onSend={(text) => send(selected.id, text)}
          />
        ) : (
          <EmptyPane />
        )}
      </div>
    </div>
  );
}
