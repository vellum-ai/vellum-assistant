/**
 * Bubble copy for the sidenav-gating experiment.
 *
 * Voice rules from the experiment design, tightened by the copy review
 * (people don't read): the bubble is a caption, not a paragraph — under 12
 * words, one idea. The buttons carry the fork, so the bubble never asks the
 * question the buttons already pose. Labels are 1-3 words, verbs first.
 * Never say "locked" or "soon" — items aren't withheld, they're
 * empty-because-early. Each button either sends a message on the user's
 * behalf (tagged `nav_redirect`), prefills the composer so the user finishes
 * the sentence, or dismisses. The second click on the same item gets a
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
        message: "Everything I build for you lands here. Empty so far.",
        buttons: [
          {
            label: "Build something",
            action: {
              kind: "send",
              text: "I want to build something. Let's talk about what.",
            },
          },
          {
            label: "Like what?",
            action: {
              kind: "send",
              text: "What kind of things could you build for me?",
            },
          },
        ],
      },
      {
        message: "Still empty. Want to change that?",
        buttons: [
          {
            label: "Let's build something",
            action: {
              kind: "send",
              text: "I want to build something. Let's talk about what.",
            },
          },
          {
            label: "Show me examples",
            action: {
              kind: "send",
              text: "Show me examples of what you could build.",
            },
          },
        ],
      },
    ],
  },
  "new-conversation": {
    variants: [
      {
        message: "New topic? Just say it here. I can keep up.",
        buttons: [
          {
            label: "New topic",
            action: { kind: "send", text: "Let's switch topics." },
          },
          { label: "Never mind", action: { kind: "dismiss" } },
        ],
      },
      {
        message: "Still just us. Switch topics anytime.",
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
        message: "Old chats live here. We're still in our first.",
        buttons: [{ label: "Back to it", action: { kind: "dismiss" } }],
      },
      {
        message: "Still just the one. Let's make it a good one.",
        buttons: [{ label: "Back to it", action: { kind: "dismiss" } }],
      },
    ],
  },
  settings: {
    variants: [
      {
        message: "Hunting for a setting? Just ask me.",
        buttons: [
          {
            label: "Change something",
            action: { kind: "prefill", text: "I was looking for a setting: " },
          },
          {
            label: "What can I change?",
            action: { kind: "send", text: "What can I customize about you?" },
          },
        ],
      },
      {
        message: "I'm faster than the settings page. What do you need?",
        buttons: [
          {
            label: "Change something",
            action: { kind: "prefill", text: "I was looking for a setting: " },
          },
          {
            label: "What can I change?",
            action: { kind: "send", text: "What can I customize about you?" },
          },
        ],
      },
    ],
  },
  "assistant-profile": {
    variants: [
      {
        message: "That's me and what I know about you. Mostly blank so far.",
        buttons: [
          {
            label: "Share something",
            action: {
              kind: "prefill",
              text: "Something to know about me: ",
            },
          },
          {
            label: "What do you know?",
            action: {
              kind: "send",
              text: "What do you know about me so far?",
            },
          },
        ],
      },
      {
        message: "It fills in as we talk. Give it something to say?",
        buttons: [
          {
            label: "Share something",
            action: {
              kind: "prefill",
              text: "Something to know about me: ",
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
        message: "How much I do on my own. Default's fine for now.",
        buttons: [
          {
            label: "What could you handle?",
            action: {
              kind: "send",
              text: "What could you do for me with more access?",
            },
          },
          { label: "Never mind", action: { kind: "dismiss" } },
        ],
      },
      {
        message: "Ask-first or just-do-it. Matters once we're doing real things.",
        buttons: [
          {
            label: "What could you handle?",
            action: {
              kind: "send",
              text: "What could you do for me with more access?",
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
        message: "The model that powers me. Default's right for now.",
        buttons: [
          {
            label: "What's underneath?",
            action: {
              kind: "send",
              text: "What model are you running, and when would switching matter?",
            },
          },
          { label: "Never mind", action: { kind: "dismiss" } },
        ],
      },
      {
        message: "Swapping's here when you need it. Not right now.",
        buttons: [
          {
            label: "When would I?",
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
};

/** Copy for a gated item's bubble; `attempt` is 1-based (the click count). */
export function navGateBubbleCopy(
  item: NavGateItemId,
  attempt: number,
): NavGateBubbleCopy {
  const { variants } = COPY[item];
  return attempt >= 2 ? variants[1] : variants[0];
}
