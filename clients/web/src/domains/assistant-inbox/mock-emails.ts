/**
 * Fixture mail for the Assistant Inbox stories.
 *
 * Timestamps are relative to {@link MOCK_NOW} so the list draws the same
 * "today" times and "Sep 12" dates on every run. The set covers what the
 * real list will have to carry: a message with attachments, a
 * sender with no display name, a long subject, an outbound reply that
 * threads an inbound message, and an assistant-initiated send.
 */
import type { InboxEmail, InboxUsage } from "./types";

export const MOCK_NOW = new Date("2026-09-16T15:40:00");

export const MOCK_ASSISTANT_NAME = "Velly";
export const MOCK_ASSISTANT_HANDLE = "velly";
export const MOCK_ROOT_DOMAIN = "vellum.me";
export const MOCK_ADDRESS = `hi@${MOCK_ASSISTANT_HANDLE}.${MOCK_ROOT_DOMAIN}`;

const VELLY = { name: MOCK_ASSISTANT_NAME, address: MOCK_ADDRESS };
const YOU = { name: "Alex Rivera", address: "alex@example.com" };

function at(daysAgo: number, hour: number, minute = 0): string {
  const date = new Date(MOCK_NOW);
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

export const MOCK_INBOX: InboxEmail[] = [
  {
    id: "in-1",
    direction: "inbound",
    from: {
      name: "Dr. Patel's Office",
      address: "front-desk@lakeside-dental.example.com",
    },
    to: [VELLY],
    subject: "Reminder: cleaning on Thursday at 9:30",
    snippet:
      "Hi Velly, this is a reminder that Alex has a cleaning booked for Thursday...",
    body: "Hi Velly,\n\nThis is a reminder that Alex has a cleaning booked for Thursday, September 18 at 9:30am with Dr. Patel.\n\nPlease reply to confirm, or let us know if you need to move it. We hold the slot until Wednesday noon.\n\nThanks,\nLakeside Dental",
    createdAt: at(0, 14, 5),
    attachments: [],
  },
  {
    id: "in-2",
    direction: "inbound",
    from: { name: "Maya Chen", address: "maya@northwind.example.org" },
    to: [VELLY],
    subject: "Q4 vendor contract for review",
    snippet:
      "Attaching the redlined contract and the pricing sheet. Can Alex take a look before Friday?",
    body: "Hi Velly,\n\nAttaching the redlined contract and the updated pricing sheet. Can Alex take a look before Friday? The main change is in section 4, where we moved to net-45 terms.\n\nHappy to jump on a call if anything is unclear.\n\nBest,\nMaya",
    createdAt: at(0, 9, 52),
    attachments: [
      {
        id: "att-1",
        filename: "Northwind-MSA-redline.pdf",
        contentType: "application/pdf",
        sizeBytes: 1_284_000,
      },
      {
        id: "att-2",
        filename: "Q4-pricing.xlsx",
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: 48_200,
      },
    ],
  },
  {
    id: "in-3",
    direction: "inbound",
    from: { address: "no-reply@flights.example.net" },
    to: [VELLY],
    subject: "Your flight SFO to JFK on Sep 22 has a gate change",
    snippet:
      "Flight UA 512 will now depart from gate B24. Departure time is unchanged.",
    body: "Flight UA 512 on Monday, September 22 will now depart from gate B24 instead of B18.\n\nDeparture time is unchanged at 7:05am. Boarding begins at 6:30am.\n\nThis is an automated message.",
    createdAt: at(1, 18, 20),
    attachments: [],
  },
  {
    id: "in-4",
    direction: "inbound",
    from: { name: "Sam Okafor", address: "sam.okafor@example.com" },
    to: [VELLY],
    subject: "Re: Dinner on the 20th?",
    snippet:
      "Saturday works. Somewhere in the Mission? I can book if you tell me a time.",
    body: "Saturday works! Somewhere in the Mission? I can book if you tell me a time.\n\nAlso, tell Alex I still have his charger.\n\nSam",
    createdAt: at(2, 11, 8),
    attachments: [],
  },
  {
    id: "in-5",
    direction: "inbound",
    from: {
      name: "The Weekly Brief",
      address: "hello@weeklybrief.example.org",
    },
    to: [VELLY],
    subject: "This week: the three things worth reading",
    snippet:
      "A long read on why cities are quieter than they used to be, a short one on sourdough, and...",
    body: "A long read on why cities are quieter than they used to be, a short one on sourdough hydration, and an interview with the person who names paint colors.\n\nRead on the web if this looks wrong in your client.",
    createdAt: at(4, 7, 30),
    attachments: [],
  },
];

export const MOCK_SENT: InboxEmail[] = [
  {
    id: "out-1",
    direction: "outbound",
    from: VELLY,
    to: [
      {
        name: "Dr. Patel's Office",
        address: "front-desk@lakeside-dental.example.com",
      },
    ],
    subject: "Re: Reminder: cleaning on Thursday at 9:30",
    snippet: "Confirmed, thank you. Alex will be there Thursday at 9:30.",
    body: "Confirmed, thank you. Alex will be there Thursday at 9:30.\n\nVelly\nAssistant to Alex Sidhu",
    createdAt: at(0, 14, 12),
    attachments: [],
  },
  {
    id: "out-2",
    direction: "outbound",
    from: VELLY,
    to: [{ name: "Sam Okafor", address: "sam.okafor@example.com" }],
    subject: "Re: Dinner on the 20th?",
    snippet:
      "7:30 on Saturday works for Alex. Foreign Cinema if they have a table?",
    body: "7:30 on Saturday works for Alex. Foreign Cinema if they have a table? If not, anywhere on Valencia is fine.\n\nHe says thanks for holding on to the charger.\n\nVelly",
    createdAt: at(2, 11, 40),
    attachments: [],
  },
  {
    id: "out-3",
    direction: "outbound",
    from: VELLY,
    to: [YOU],
    subject: "Your week, in one place",
    snippet:
      "Three meetings moved, one contract waiting on you, and the dentist is Thursday.",
    body: "Morning. Here is where the week stands.\n\nThree meetings moved: the design review is now Wednesday at 2, the 1:1 with Priya slid to Thursday, and Friday's planning is cancelled.\n\nMaya sent the Northwind contract. The only material change is net-45 terms in section 4. I flagged it in the doc.\n\nDentist is Thursday at 9:30. I confirmed it.\n\nVelly",
    createdAt: at(3, 8, 0),
    attachments: [
      {
        id: "att-3",
        filename: "week-of-sep-15.md",
        contentType: "text/markdown",
        sizeBytes: 3_900,
      },
    ],
  },
];

export const MOCK_USAGE: InboxUsage = {
  sentToday: 3,
  receivedToday: 2,
  dailyLimit: 100,
};
