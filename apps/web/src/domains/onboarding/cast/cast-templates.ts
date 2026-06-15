/**
 * Templated user messages + mocked assistant scripts for the Cast two-panel
 * demo. Every left-panel tap maps to a specific user message (what the user
 * "said") and a scripted assistant response (what they watch happen). This is a
 * DEMO mock — no real model call — but it renders through the real chat
 * components and fake-streams (text deltas + a web_search tool step) so it reads
 * as the genuine assistant working.
 */

import type { JobKey, RatherKey } from "@/domains/onboarding/cast/cast-content";

/**
 * Inlined from the excluded `cast-hooks` module. `cast-hooks` also exports
 * fire-and-forget context-kickoff stubs (React/console side effects) that are
 * out of scope for these pure data modules. Only the `StyleProfile` shape is
 * needed here, so it is inlined to keep the import graph clean.
 */
export interface StyleProfile {
  autonomy?: "send_it" | "show_me";
  tone?: "point" | "walk";
  shape?: "one" | "few";
}

export interface AssistantScript {
  /** A short line the assistant says before searching. */
  prelude: string;
  /** Optional web_search step shown as a real tool chip. */
  search?: { query: string; result: string };
  /** The main body the assistant streams after (markdown ok). */
  body: string;
}

export interface CastTurn {
  /** The templated user message (what the tap "sent"). */
  user: string;
  script: AssistantScript;
}

/* ---------------- Beat 3: Job ---------------- */

const JOB_TURNS: Record<JobKey, CastTurn> = {
  building: {
    user: "I want help with building things. Get started on something useful for me.",
    script: {
      prelude: "Love it — let me see what builders are reaching for right now.",
      search: {
        query: "best lightweight project scaffolding tools 2026",
        result: "Found current picks across Vite, Bun, and Turbo starter templates.",
      },
      body: "Here's a starting point: a **one-command project starter** tuned to how you work, with the boring setup (lint, format, CI) already wired. I'll keep a running list of build ideas as we go.",
    },
  },
  writing: {
    user: "I want help with writing. Get started on something useful for me.",
    script: {
      prelude: "On it — let me pull a few sharp examples to model the voice.",
      search: {
        query: "examples of crisp punchy product writing",
        result: "Pulled a handful of well-regarded short-form writing samples.",
      },
      body: "I drafted a **tight writing kit**: a reusable outline, a punch-up checklist, and three opening lines you can steal. Want me to apply it to something specific?",
    },
  },
  designing: {
    user: "I want help with design. Get started on something useful for me.",
    script: {
      prelude: "Let me scan what's landing well in design right now.",
      search: {
        query: "2026 UI design trends dark mode editorial",
        result: "Gathered current palette + type-pairing references.",
      },
      body: "Made you a **starter palette + type pairing** that leans editorial, plus a one-screen layout to riff on. I'll keep references handy as you explore.",
    },
  },
  fundraising: {
    user: "I want help with fundraising. Get started on something useful for me.",
    script: {
      prelude: "Let me look at what's resonating with investors lately.",
      search: {
        query: "what investors want in a seed deck 2026",
        result: "Collected recent guidance on seed-stage narrative + metrics.",
      },
      body: "Outlined a **10-slide deck skeleton** with the narrative beats and the two metrics to lead with. Point me at your numbers and I'll fill it in.",
    },
  },
  operating: {
    user: "I want help operating the business. Get started on something useful for me.",
    script: {
      prelude: "Let me find a lightweight ops cadence that won't drown you.",
      search: {
        query: "simple weekly operating cadence small team",
        result: "Found a few low-overhead weekly review templates.",
      },
      body: "Set up a **weekly ops checklist** — metrics, blockers, one decision — that takes 15 minutes. I can run it for you each week.",
    },
  },
  teaching: {
    user: "I want help with teaching. Get started on something useful for me.",
    script: {
      prelude: "Let me grab a couple of strong lesson structures.",
      search: {
        query: "effective lesson plan structure active learning",
        result: "Pulled proven active-learning lesson frameworks.",
      },
      body: "Built a **reusable lesson template** with a hook, one core idea, and a quick check-for-understanding. Tell me the topic and I'll fill it.",
    },
  },
  healing: {
    user: "I want help with caregiving and wellbeing. Get started on something useful for me.",
    script: {
      prelude: "Let me find gentle, well-sourced routines.",
      search: {
        query: "evidence-based daily wellbeing routine",
        result: "Gathered a few low-effort, well-cited routines.",
      },
      body: "Drafted a **small daily routine** — two minutes of breathing, one walk, one check-in. I'll nudge you and keep it flexible.",
    },
  },
  making: {
    user: "I want help making things with my hands. Get started on something useful for me.",
    script: {
      prelude: "Let me see what makers are building this season.",
      search: {
        query: "beginner-friendly weekend maker projects",
        result: "Found a set of approachable weekend build projects.",
      },
      body: "Picked a **first weekend project** with a parts list and steps, sized to finish in an afternoon. Want the shopping list now?",
    },
  },
};

export function jobTurn(key: JobKey): CastTurn {
  return JOB_TURNS[key];
}

/* ---------------- Beat 4: Rather ---------------- */

const RATHER_LINES: Record<RatherKey, string> = {
  beach: "By the way, I'd rather be at the beach right now. Use that.",
  sleeping: "Honestly I'd rather be asleep. Keep that in mind.",
  reading: "I'd rather be reading right now. Use that.",
  hiking: "By the way, I'd rather be hiking right now. Use that.",
  cooking: "I'd rather be cooking right now. Use that.",
  gaming: "I'd rather be gaming right now. Use that.",
  traveling: "I'd rather be traveling right now. Use that.",
  friends: "I'd rather be hanging with friends right now. Use that.",
};

export function ratherTurn(key: RatherKey, label: string): CastTurn {
  return {
    user: RATHER_LINES[key],
    script: {
      prelude: `Noted — I'll weave ${label.toLowerCase()} into how I help.`,
      body: `Got it. I'll look for ways to give you more time for **${label.toLowerCase()}**, and keep my help quick so it doesn't eat into it.`,
    },
  };
}

/* ---------------- Beat 5: This / That ---------------- */

/** Templated message per This/That value (keyed by the round value strings). */
const STYLE_LINES: Record<string, string> = {
  send_it: "When I'm ready to act, just send it. Don't ask.",
  show_me: "When I'm ready to act, show me first before doing anything.",
  point: "When you explain something, get straight to the point.",
  walk: "When you explain something, walk me through it.",
  one: "When you help, focus on one thing and do it well.",
  few: "When you help, knock out a few quick wins in parallel.",
};

export function styleTurn(value: string): CastTurn {
  return {
    user: STYLE_LINES[value] ?? "Use that style.",
    script: {
      prelude: "Got it — locking that into how I work.",
      body: "Understood. I'll keep that in mind for everything from here.",
    },
  };
}

/* ---------------- Endpoints: synthesized first reply ---------------- */

export interface CastPicks {
  jobs: JobKey[];
  rathers: RatherKey[];
  style: StyleProfile;
}

const JOB_NOUN: Record<JobKey, string> = {
  building: "a builder",
  writing: "a writer",
  designing: "a designer",
  fundraising: "someone in fundraising mode",
  operating: "an operator",
  teaching: "a teacher",
  healing: "a caretaker",
  making: "a maker",
};

const RATHER_PLACE: Record<RatherKey, string> = {
  beach: "outside",
  sleeping: "getting some rest",
  reading: "lost in a book",
  hiking: "out on a trail",
  cooking: "in the kitchen",
  gaming: "playing something",
  traveling: "somewhere new",
  friends: "with people you like",
};

/**
 * Build the "inference, not recital" first reply for the endpoint chat. The
 * activation IS the memory — this synthesizes a read of the user from the picks
 * rather than listing them back. Deterministic (mock), Sonnet-shaped.
 */
export function castInferenceReply(picks: CastPicks): string {
  const { jobs, rathers, style } = picks;
  const noun = jobs[0] ? JOB_NOUN[jobs[0]] : "someone with a clear direction";
  const more = jobs.length > 1 ? " (among other things)" : "";
  const place = rathers[0] ? RATHER_PLACE[rathers[0]] : "doing your own thing";

  const autonomy =
    style.autonomy === "send_it"
      ? "you'd rather I just act than ask for permission"
      : style.autonomy === "show_me"
        ? "you want a look before I do anything"
        : "you'll tell me how much rope to give you";
  const tone =
    style.tone === "point"
      ? "keep it brief"
      : style.tone === "walk"
        ? "walk you through the why"
        : "match my detail to the moment";
  const shape =
    style.shape === "few"
      ? "a few quick wins in parallel"
      : style.shape === "one"
        ? "one solid thing done well"
        : "whatever shape fits";

  return [
    `My read: you're ${noun}${more} who'd rather be ${place} — so you probably want something tangible to show for your time, not busywork.`,
    `On how to work with you: ${autonomy}, ${tone}, and lean toward ${shape}.`,
    `That's the deal — I'll carry the boring parts so you can get back to it. Where do you want to start?`,
  ].join("\n\n");
}

/** A turn for the endpoint chat: the user's first message + the synthesized reply. */
export function endpointTurn(userText: string, picks: CastPicks): CastTurn {
  return { user: userText, script: { prelude: "", body: castInferenceReply(picks) } };
}
