import {
  Brain,
  CircleUser,
  MessageCircle,
  PanelLeft,
  Plus,
  type LucideIcon,
} from "lucide-react";

export interface TourStep {
  /** Matches a `data-tour-id` attribute on the target nav element. */
  id: string;
  title: string;
  body: string;
  /** Rendered large beside the title in the narration's chip, mirroring
   *  the target's own icon where it has one. Absent on the intro. */
  icon?: LucideIcon;
}

/**
 * ms per character for the tour narration typewriter. The avatar tour derives
 * its dwell time on each stop from this, so the flight resumes only after the
 * full description has finished typing plus a reading pause.
 */
export const TYPE_CHAR_MS = 14;

/**
 * Narration-only opener typed in the main area while the avatar hovers at
 * its launch point, before the first nav stop. Has no `data-tour-id` target.
 */
export const TOUR_INTRO: TourStep = {
  id: "intro",
  title: "Welcome",
  body: "Let me show you around",
};

/**
 * The side-menu takeover beat: the avatar grows over the freshly revealed
 * sidebar while this line types, before the item-by-item walk. Targets the
 * whole `#chat-side-menu` region rather than a `data-tour-id` anchor.
 */
export const TOUR_SIDEBAR: TourStep = {
  id: "side-menu",
  title: "Your sidebar",
  body: "Everything lives here — our chats, my page, your settings.",
  icon: PanelLeft,
};

/**
 * The finale: the chat composer gets the same takeover treatment as the
 * side menu — the flood pours over the input with the eyes surfacing —
 * ending the tour where the real conversation starts. Targets the
 * composer's `data-slot` anchor rather than a `data-tour-id`.
 */
export const TOUR_COMPOSER: TourStep = {
  id: "chat-composer",
  title: "Your chat",
  body: "Don't get distracted by all the noise, start by talking to me!",
  icon: MessageCircle,
};

export const TOUR_STEPS: TourStep[] = [
  {
    id: "assistant-page",
    title: "Your Assistant",
    body: "My personality, the library of things I've built for you, and more. I keep it all tidy — you never have to.",
    icon: Brain,
  },
  {
    id: "new-chat",
    title: "New Chat",
    body: "A fresh chat when you want one.",
    icon: Plus,
  },
  {
    id: "settings",
    title: "Settings",
    body: "Preferences and account stuff. It can wait.",
    icon: CircleUser,
  },
];
