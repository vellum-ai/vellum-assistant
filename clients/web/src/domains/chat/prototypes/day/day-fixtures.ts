/**
 * Seed data for the day-oriented prototypes: what replaces the recent
 * conversations list, and the calendar page.
 *
 * One day, three calendars, a handful of planned blocks with what the
 * assistant recorded actually happening in them, open tasks in a few states,
 * and the assistant's own notes on the items it has something to say about.
 * Every item can carry a thread, the same way a message can.
 */

import {
  PROTO_NOW,
  type ProtoMessage,
  type ProtoThread,
} from "../threaded-chat/fixtures";

export type CalendarKey = "work" | "personal" | "family";

export type AgendaKind =
  /** A calendar event with a fixed time. */
  | "event"
  /** A time block the user planned for a piece of work. */
  | "block"
  /** A reminder the assistant will surface at a time. */
  | "reminder"
  /** Work the assistant is doing or holding for the user. */
  | "task";

export type AgendaStatus =
  | "planned"
  | "running"
  | "waiting-on-you"
  | "done"
  | "missed";

export type NoteTone = "info" | "ready" | "warn";

export interface AgendaNote {
  text: string;
  tone: NoteTone;
}

export interface AgendaItem {
  id: string;
  kind: AgendaKind;
  title: string;
  /** Epoch ms. Tasks without a time float in the day. */
  start?: number;
  end?: number;
  calendar?: CalendarKey;
  location?: string;
  status: AgendaStatus;
  /** What the assistant has to say about the item. */
  note?: AgendaNote;
  /** For a block: what the assistant recorded happening in it. */
  actual?: { summary: string; onPlanMinutes: number; offPlanMinutes: number };
  /** The item's thread, when the user and assistant have talked about it. */
  thread?: ProtoThread;
}

export interface RecentConversation {
  id: string;
  title: string;
  at: number;
  unread?: boolean;
}

export interface DaySeed {
  now: number;
  items: AgendaItem[];
  recents: RecentConversation[];
}

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Midnight UTC of the fixture day. */
export const DAY_START = Math.floor(PROTO_NOW / (24 * HOUR)) * 24 * HOUR;

/** A clock time on the fixture day. */
export function at(hour: number, minute = 0): number {
  return DAY_START + hour * HOUR + minute * MIN;
}

function msg(
  id: string,
  author: ProtoMessage["author"],
  text: string,
  atMs: number,
): ProtoMessage {
  return { id, author, text, at: atMs };
}

function thread(
  parentId: string,
  replies: ProtoMessage[],
  unread = 0,
): ProtoThread {
  return {
    conversationId: `thread-${parentId}`,
    parentMessageId: parentId,
    replies,
    unread,
  };
}

export const CALENDAR_LABELS: Record<CalendarKey, string> = {
  work: "Work",
  personal: "Personal",
  family: "Family",
};

export const DAY_SEED: DaySeed = {
  now: PROTO_NOW,
  items: [
    {
      id: "briefing",
      kind: "task",
      title: "Morning briefing",
      start: at(7, 45),
      status: "done",
      note: { text: "Sent 7:45. Three things need you today.", tone: "info" },
      thread: thread("briefing", [
        msg(
          "briefing-1",
          "assistant",
          [
            "Good morning. Three things need you today:",
            "",
            "1. Launch review at 14:00 has 3 open questions",
            "2. Domain renewal needs your approval",
            "3. Leo's practice may overlap the 1:1 with Sam",
          ].join("\n"),
          at(7, 45),
        ),
      ]),
    },
    {
      id: "design-sync",
      kind: "event",
      title: "Design sync",
      start: at(9, 30),
      end: at(10, 0),
      calendar: "work",
      status: "done",
      note: { text: "Brief ready. Two decisions carried over.", tone: "ready" },
      thread: thread("design-sync", [
        msg(
          "ds-1",
          "assistant",
          "Brief for Design sync: last week's two open decisions are the icon set and the empty state. Sam owns both. Notes from the previous sync are attached.",
          at(9, 15),
        ),
        msg("ds-2", "user", "Add the thread indicator question.", at(9, 20)),
        msg("ds-3", "assistant", "Added as item 3.", at(9, 20)),
      ]),
    },
    {
      id: "block-email",
      kind: "block",
      title: "Launch email draft",
      start: at(10, 0),
      end: at(11, 30),
      status: "done",
      actual: {
        summary: "Drafted v2 together, 55 min. 20 min in Slack, 15 min on the auth PR.",
        onPlanMinutes: 55,
        offPlanMinutes: 35,
      },
      thread: thread("block-email", [
        msg(
          "be-1",
          "assistant",
          "Held for the launch email. I have the first draft ready when you are.",
          at(10, 0),
        ),
        msg("be-2", "user", "Punchier. Lead with the pain.", at(10, 12)),
        msg(
          "be-3",
          "assistant",
          "Saved **Launch email v2** to Drafts and added it to the 14:00 agenda.",
          at(10, 55),
        ),
      ]),
    },
    {
      id: "usage",
      kind: "task",
      title: "Pull last week's usage numbers",
      start: at(12, 52),
      status: "done",
      thread: thread("usage", [
        msg(
          "u-1",
          "assistant",
          "Weekly active 4,210 (+6.2%). Threads opened 1,930, first week with that number. Median reply time 41s (-12%).",
          at(12, 52),
        ),
      ]),
    },
    {
      id: "lunch",
      kind: "event",
      title: "Lunch with Priya",
      start: at(13, 0),
      end: at(14, 0),
      calendar: "personal",
      location: "La Fonda",
      status: "done",
      note: { text: "12 min walk. Leave by 12:45.", tone: "info" },
    },
    {
      id: "launch-review",
      kind: "event",
      title: "Launch review",
      start: at(14, 0),
      end: at(15, 0),
      calendar: "work",
      status: "done",
      note: { text: "Brief ready. 3 open questions for the room.", tone: "ready" },
      thread: thread(
        "launch-review",
        [
          msg(
            "lr-1",
            "assistant",
            [
              "Brief for Launch review:",
              "",
              "- Email v2 is in Drafts, growth has not seen it",
              "- Open: send date, the pricing line, who owns the blog post",
              "- Usage numbers from this morning are attached",
            ].join("\n"),
            at(13, 40),
          ),
          msg("lr-2", "user", "Who was pushing back on the pricing line?", at(15, 5)),
          msg(
            "lr-3",
            "assistant",
            "Dana, in the thread on Tuesday. Her worry is that it reads as a price increase. I can draft two alternatives.",
            at(15, 6),
          ),
        ],
        1,
      ),
    },
    {
      id: "block-inbox",
      kind: "block",
      title: "Inbox and PR reviews",
      start: at(15, 30),
      end: at(16, 15),
      status: "running",
      actual: {
        summary: "Reviewed the auth PR (18 min). Inbox not started.",
        onPlanMinutes: 18,
        offPlanMinutes: 22,
      },
    },
    {
      id: "domain",
      kind: "task",
      title: "Renew vellum.example domain",
      status: "waiting-on-you",
      note: { text: "Needs your approval. Expires in 4 days.", tone: "warn" },
      thread: thread("domain", [
        msg(
          "dom-1",
          "assistant",
          "The domain expires Monday. Renewing for 2 years is $34. Approve and I will do it now.",
          at(11, 40),
        ),
      ]),
    },
    {
      id: "retro-notes",
      kind: "reminder",
      title: "Send Sam the retro notes",
      start: at(16, 0),
      status: "planned",
      note: { text: "Notes attached. I will nudge you at 16:00.", tone: "info" },
    },
    {
      id: "one-on-one",
      kind: "event",
      title: "1:1 with Sam",
      start: at(16, 30),
      end: at(17, 0),
      calendar: "work",
      status: "planned",
      note: { text: "Brief ready. Retro notes and the icon set decision.", tone: "ready" },
      thread: thread("one-on-one", [
        msg(
          "oo-1",
          "assistant",
          "For the 1:1: the retro notes, the icon set decision from Design sync, and Sam asked last week about the on-call rotation.",
          at(16, 0),
        ),
      ]),
    },
    {
      id: "soccer",
      kind: "event",
      title: "Leo's soccer practice",
      start: at(17, 0),
      end: at(18, 0),
      calendar: "family",
      location: "Riverside field",
      status: "planned",
      note: {
        text: "Starts as the 1:1 ends. 15 min drive, so the 1:1 cannot run over.",
        tone: "warn",
      },
      thread: thread("soccer", [
        msg(
          "soc-1",
          "assistant",
          "Practice starts at 17:00 at Riverside, a 15 min drive. Your 1:1 with Sam ends at 17:00. Want me to move the 1:1 to 16:15, or tell Sam you have a hard stop?",
          at(15, 10),
        ),
      ]),
    },
    {
      id: "dinner",
      kind: "event",
      title: "Dinner with the Nguyens",
      start: at(19, 0),
      end: at(21, 0),
      calendar: "family",
      status: "planned",
    },
  ],
  recents: [
    { id: "r1", title: "Morning briefing", at: at(7, 45) },
    { id: "r2", title: "Launch email draft", at: at(10, 55) },
    { id: "r3", title: "Usage numbers", at: at(12, 52) },
    { id: "r4", title: "Launch review brief", at: at(15, 6), unread: true },
    { id: "r5", title: "Cozy gift ideas", at: at(-9, 0) },
    { id: "r6", title: "Apple Reminders access", at: at(-13, 30) },
    { id: "r7", title: "OS beta image support bug", at: at(-40, 0) },
    { id: "r8", title: "Pointing device detection", at: at(-52, 0) },
    { id: "r9", title: "Email address inquiry", at: at(-75, 0) },
    { id: "r10", title: "Assistant roadmap command", at: at(-100, 0) },
    { id: "r11", title: "Taylor Swift gift ideas", at: at(-150, 0) },
    { id: "r12", title: "Access request from Tirman", at: at(-160, 0) },
    { id: "r13", title: "ACP session model selection", at: at(-200, 0) },
  ],
};
