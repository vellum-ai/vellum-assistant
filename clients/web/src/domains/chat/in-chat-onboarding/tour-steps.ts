import {
  AudioLines,
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
  body: "Everything lives here: our chats, my page, your settings.",
  icon: PanelLeft,
};

/**
 * The chat beat: the composer gets the same takeover treatment as the side
 * menu, the flood pouring over the input with the eyes surfacing, landing the
 * tour where the real conversation starts. Targets the composer's `data-slot`
 * anchor rather than a `data-tour-id`.
 */
export const TOUR_COMPOSER: TourStep = {
  id: "chat-composer",
  title: "Your chat",
  body: "I have tons of features, but let's chat before you start exploring!",
  icon: MessageCircle,
};

/**
 * The finale: the composer flood drains and the whole avatar drops onto the
 * voice button, perching on its top edge. The control itself is left alone,
 * so the tour ends pointing at the affordance the user meets next rather than
 * covering it.
 *
 * Targets `data-tour-id="voice-mode"` inside the overlay's scenery composer.
 * The button renders only for an assistant that serves live voice, and a beat
 * whose anchor is missing is skipped, so an ineligible assistant ends the tour
 * on the chat beat instead.
 */
export const TOUR_VOICE: TourStep = {
  id: "voice-mode",
  title: "Voice mode",
  body: "Or we can speak to each other. It's faster and more natural.",
  icon: AudioLines,
};

export const TOUR_STEPS: TourStep[] = [
  {
    id: "assistant-page",
    title: "Your Assistant",
    body: "My personality, things I've built for you, and more. I keep it all tidy so you never have to.",
    icon: Brain,
  },
  {
    id: "new-chat",
    title: "New Chat",
    body: "You probably already know this one.",
    icon: Plus,
  },
  {
    id: "settings",
    title: "Settings",
    body: "Preferences and account stuff. It can wait.",
    icon: CircleUser,
  },
];
