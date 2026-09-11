/**
 * Seed data for the threaded-chat prototype.
 *
 * The shape mirrors what a shipped version would persist: one top-level
 * conversation, and each thread is its own conversation keyed by the message
 * it hangs off. The prototype only reads and appends; nothing here is wired
 * to the daemon.
 */

export type ProtoAuthor = "user" | "assistant";

export interface ProtoMessage {
  id: string;
  author: ProtoAuthor;
  /** Markdown body. */
  text: string;
  /** Epoch ms. Fixtures are anchored to {@link PROTO_NOW} so relative
   *  timestamps render the same on every load. */
  at: number;
}

export interface ProtoThread {
  /** The thread's own conversation id: threads are conversations. */
  conversationId: string;
  /** The top-level message the thread hangs off. */
  parentMessageId: string;
  replies: ProtoMessage[];
  /** Replies the user has not seen yet. */
  unread: number;
}

export interface ProtoState {
  main: ProtoMessage[];
  threads: Record<string, ProtoThread>;
}

/** A fixed "now" so the fixture's relative times never drift. */
export const PROTO_NOW = Date.UTC(2026, 8, 11, 16, 30);

const MIN = 60_000;
const HOUR = 60 * MIN;

function ago(ms: number): number {
  return PROTO_NOW - ms;
}

function msg(
  id: string,
  author: ProtoAuthor,
  text: string,
  at: number,
): ProtoMessage {
  return { id, author, text, at };
}

export const PROTO_ASSISTANT_NAME = "Vellum";
export const PROTO_USER_NAME = "You";

export const SEED_STATE: ProtoState = {
  main: [
    msg(
      "m1",
      "user",
      "Morning. What does my day look like?",
      ago(26 * HOUR + 12 * MIN),
    ),
    msg(
      "m2",
      "assistant",
      [
        "Light morning, packed afternoon:",
        "",
        "- **9:30** Design sync (30 min)",
        "- **13:00** Lunch with Priya, La Fonda",
        "- **14:00** Launch review with the growth team",
        "- **16:30** 1:1 with Sam",
        "",
        "You have a 90 minute gap after the design sync. Want me to hold it for the launch email draft?",
      ].join("\n"),
      ago(26 * HOUR + 11 * MIN),
    ),
    msg(
      "m3",
      "user",
      "Yes, hold it. And draft the launch email so I can react to it.",
      ago(26 * HOUR + 9 * MIN),
    ),
    msg(
      "m4",
      "assistant",
      [
        "Held 10:00 to 11:30 as **Launch email draft**. Here is a first pass:",
        "",
        "> **Subject:** Threads are here",
        ">",
        "> Every conversation now stays in one place. Reply to any message to open a thread, keep the main chat clean, and come back to the details when you need them.",
        "",
        "I kept it short. Want a longer version with a feature list, or a punchier one?",
      ].join("\n"),
      ago(26 * HOUR + 8 * MIN),
    ),
    msg(
      "m5",
      "user",
      "Can you pull the numbers from last week's usage report?",
      ago(3 * HOUR + 40 * MIN),
    ),
    msg(
      "m6",
      "assistant",
      [
        "From the report shared on Friday:",
        "",
        "| Metric | Last week | Change |",
        "| --- | --- | --- |",
        "| Weekly active | 4,210 | +6.2% |",
        "| Threads opened | 1,930 | new |",
        "| Median reply time | 41s | -12% |",
        "",
        "Threads opened is the first week we have that number, so there is no comparison yet.",
      ].join("\n"),
      ago(3 * HOUR + 38 * MIN),
    ),
    msg(
      "m7",
      "user",
      "Remind me to send Sam the retro notes before our 1:1.",
      ago(52 * MIN),
    ),
    msg(
      "m8",
      "assistant",
      "Done. I will nudge you at **16:15**, fifteen minutes before the 1:1, with the retro notes attached.",
      ago(51 * MIN),
    ),
    msg(
      "m9",
      "user",
      "Is the build green after the auth change?",
      ago(6 * MIN),
    ),
    msg(
      "m10",
      "assistant",
      "Yes. CI passed 4 minutes ago on `main`. The auth change added 2 tests and both pass. Nothing is waiting on you.",
      ago(5 * MIN),
    ),
  ],
  threads: {
    m4: {
      conversationId: "thread-m4",
      parentMessageId: "m4",
      unread: 0,
      replies: [
        msg(
          "m4-r1",
          "user",
          "Punchier. And lead with the pain, not the feature.",
          ago(26 * HOUR + 2 * MIN),
        ),
        msg(
          "m4-r2",
          "assistant",
          [
            "> **Subject:** Stop losing the thread",
            ">",
            "> Long chats bury the answer you need. Now you can reply to any message and keep the detail in its own thread, so the main conversation stays readable and nothing gets lost.",
            "",
            "Better?",
          ].join("\n"),
          ago(26 * HOUR + 1 * MIN),
        ),
        msg(
          "m4-r3",
          "user",
          "Much better. Ship that.",
          ago(25 * HOUR + 58 * MIN),
        ),
        msg(
          "m4-r4",
          "assistant",
          "Saved to **Drafts / Launch email v2** and added it to the 14:00 launch review agenda.",
          ago(25 * HOUR + 57 * MIN),
        ),
      ],
    },
    m6: {
      conversationId: "thread-m6",
      parentMessageId: "m6",
      unread: 1,
      replies: [
        msg(
          "m6-r1",
          "user",
          "Why did median reply time drop?",
          ago(3 * HOUR + 20 * MIN),
        ),
        msg(
          "m6-r2",
          "assistant",
          "Two reasons. The balanced model profile rolled out to 70% of traffic on Tuesday, and the prompt cache hit rate went from 58% to 71% after the compaction fix. Most of the gain is the cache.",
          ago(3 * HOUR + 18 * MIN),
        ),
      ],
    },
    m8: {
      conversationId: "thread-m8",
      parentMessageId: "m8",
      unread: 0,
      replies: [
        msg(
          "m8-r1",
          "user",
          "Actually make it 16:00, I want time to skim them.",
          ago(48 * MIN),
        ),
        msg("m8-r2", "assistant", "Moved to **16:00**.", ago(47 * MIN)),
      ],
    },
  },
};

/** Canned assistant replies the prototype cycles through after a send. */
export const MOCK_REPLIES: readonly string[] = [
  "On it. I will have that ready in a moment.",
  "Got it. I noted that and will follow up here when it is done.",
  "Sure. Here is what I found:\n\n- Nothing is blocked\n- One item needs your call\n\nWant the detail?",
  "Done. Anything else on this one?",
];
