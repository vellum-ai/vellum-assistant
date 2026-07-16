/**
 * Bubble copy for the sidenav-gating experiment.
 *
 * Voice rules from the experiment design: never say "locked" or "soon" —
 * items aren't withheld, they're empty-because-early. Buttons turn the block
 * into a message-generator: each either sends a message on the user's behalf
 * (tagged `nav_redirect`), prefills the composer so the user finishes the
 * sentence, or just dismisses. The second click on the same item gets a
 * different line (`variants[1]`); the third click never shows copy — it
 * quietly unlocks the item instead.
 */

import type { NavGateItemId } from "@/domains/chat/nav-gate/nav-gate-store";

export type NavGateButtonAction =
  | { kind: "send"; text: string }
  | { kind: "prefill"; text: string }
  | { kind: "dismiss" };

export interface NavGateButton {
  label: string;
  action: NavGateButtonAction;
}

export interface NavGateBubbleCopy {
  message: string;
  buttons: NavGateButton[];
}

interface NavGateItemCopy {
  /** Copy per attempt: index 0 = first click, index 1 = second click. */
  variants: [NavGateBubbleCopy, NavGateBubbleCopy];
}

const COPY: Record<NavGateItemId, NavGateItemCopy> = {
  library: {
    variants: [
      {
        message:
          "This is my Library — everything I make for you (docs, apps, research) lives here. Right now it's empty because we haven't made anything yet. Something in mind, or just exploring?",
        buttons: [
          {
            label: "I have something in mind",
            action: {
              kind: "send",
              text: "I want to make something — let's talk about what.",
            },
          },
          {
            label: "Just exploring",
            action: {
              kind: "send",
              text: "Just looking around. What kind of things could you put in the Library for me?",
            },
          },
        ],
      },
      {
        message:
          "Still empty in here — we haven't made anything together yet. Want to change that?",
        buttons: [
          {
            label: "Let's make something",
            action: {
              kind: "send",
              text: "I want to make something — let's talk about what.",
            },
          },
          {
            label: "What could go here?",
            action: {
              kind: "send",
              text: "What kind of things could you put in the Library for me?",
            },
          },
        ],
      },
    ],
  },
  "new-conversation": {
    variants: [
      {
        message:
          "A fresh chat! We've barely started this one. Want to switch topics? Just say so right here — I can keep up.",
        buttons: [
          {
            label: "New topic",
            action: { kind: "send", text: "Let's switch topics." },
          },
          { label: "Never mind", action: { kind: "dismiss" } },
        ],
      },
      {
        message:
          "Still just the one conversation — and it's right here. Switch topics whenever you like; I can keep up.",
        buttons: [
          {
            label: "New topic",
            action: { kind: "send", text: "Let's switch topics." },
          },
          { label: "Never mind", action: { kind: "dismiss" } },
        ],
      },
    ],
  },
  history: {
    variants: [
      {
        message:
          "Past conversations live here. We're currently having our first one, so it's just us in there. Where were we?",
        buttons: [{ label: "Back to it", action: { kind: "dismiss" } }],
      },
      {
        message:
          "Only one conversation so far — the one we're in. Let's give it a past worth browsing first.",
        buttons: [{ label: "Back to it", action: { kind: "dismiss" } }],
      },
    ],
  },
  "assistant-profile": {
    variants: [
      {
        message:
          "That's me in there — my memory, my personality, everything I'm learning about you. It's pretty bare right now; I fill it in by doing things with you. Give me something to remember?",
        buttons: [
          {
            label: "I'll tell you something",
            action: {
              kind: "send",
              text: "Let me tell you something about me worth remembering.",
            },
          },
          {
            label: "Just exploring",
            action: {
              kind: "send",
              text: "What do you know about me so far?",
            },
          },
        ],
      },
      {
        message:
          "My page — what I remember, how I act. It fills in as we talk, and right now you could read it in one blink. Want to give it something to say?",
        buttons: [
          {
            label: "I'll tell you something",
            action: {
              kind: "send",
              text: "Let me tell you something about me worth remembering.",
            },
          },
          { label: "Never mind", action: { kind: "dismiss" } },
        ],
      },
    ],
  },
  "assistant-access": {
    variants: [
      {
        message:
          "This sets how much I can do on my own — from ask-every-time to just-handle-it. It's on a sensible default, and we haven't done anything yet where it'd matter. Want to?",
        buttons: [
          {
            label: "What would you do with it?",
            action: {
              kind: "send",
              text: "What kinds of things could you do for me if I gave you more access?",
            },
          },
          {
            label: "Just exploring",
            action: {
              kind: "send",
              text: "Just poking around. What does assistant access actually control?",
            },
          },
        ],
      },
      {
        message:
          "Ask-first or just-handle-it — that's what this controls. It'll matter once we're actually doing things together. Shall we?",
        buttons: [
          {
            label: "What could you handle?",
            action: {
              kind: "send",
              text: "What kinds of things could you do for me if I gave you more access?",
            },
          },
          { label: "Never mind", action: { kind: "dismiss" } },
        ],
      },
    ],
  },
  "model-profile": {
    variants: [
      {
        message:
          "This picks which model I think with. The default is the right call for almost everything — including a first conversation. Curious what's underneath?",
        buttons: [
          {
            label: "What's underneath?",
            action: {
              kind: "send",
              text: "What model are you running right now, and when would switching matter?",
            },
          },
          { label: "Never mind", action: { kind: "dismiss" } },
        ],
      },
      {
        message:
          "Model-swapping is here when you need it — the default suits us fine for now. Want the quick version of when it matters?",
        buttons: [
          {
            label: "When does it matter?",
            action: {
              kind: "send",
              text: "When would I want a different model profile?",
            },
          },
          { label: "Never mind", action: { kind: "dismiss" } },
        ],
      },
    ],
  },
  settings: {
    variants: [
      {
        message:
          "Settings — models, connections, preferences. Anything specific you're hunting for? I can probably just do it from here.",
        buttons: [
          {
            label: "Yes, looking for something",
            action: { kind: "prefill", text: "I was looking for a setting — " },
          },
          {
            label: "Just exploring",
            action: { kind: "send", text: "What can I customize about you?" },
          },
        ],
      },
      {
        message:
          "Odds are I can change it faster than the settings page can. What are you after?",
        buttons: [
          {
            label: "Tell you what I need",
            action: { kind: "prefill", text: "I was looking for a setting — " },
          },
          {
            label: "Just exploring",
            action: { kind: "send", text: "What can I customize about you?" },
          },
        ],
      },
    ],
  },
};

/** Copy for a gated item's bubble; `attempt` is 1-based (the click count). */
export function navGateBubbleCopy(
  item: NavGateItemId,
  attempt: number,
): NavGateBubbleCopy {
  const { variants } = COPY[item];
  return attempt >= 2 ? variants[1] : variants[0];
}
