import type { Surface } from "@/domains/chat/types/types";

/**
 * Persona fixtures for the Activation Moments Storybook spike (JARVIS-1112).
 *
 * The visual spec is explicit that one persona hides whether the surfaces
 * actually personalize or just look like they do — so every moment is mocked
 * against TWO personas whose specifics thread M1 → M4. The "specifics anchor"
 * principle: each downstream subtitle/bullet should point at a string the
 * persona supplied earlier (a paste, a name, a number), not generic copy.
 *
 * These are display-only fixtures. They are NOT wired to the backend; the
 * stories render them through `SurfaceRouter` with mock `onAction` handlers,
 * mirroring the existing `work-result-surface.stories.tsx` setup.
 */
export interface ActivationPersona {
  /** Stable key used to namespace surfaceIds so two personas can co-exist. */
  key: string;
  /** Human label shown in story names. */
  label: string;
  /** The assistant the user is porting from (substituted into the prompt). */
  priorAssistant: string;
  /** Raw-ish paste the user dropped back — drives the specifics card. */
  pastedContext: string;
  /** The 3-4 "here's what I picked up" bullets, in the user's own language. */
  specifics: string[];
  /** A concrete string from `specifics` that Moment 2's subtitle anchors to. */
  proposeAnchor: string;
  /** User-language outcome title for the single-outcome offer. */
  outcomeTitle: string;
  /** One short prose line of what will actually happen. */
  outcomeBody: string;
  /** The continuity offer for Moment 4, anchored to the run result. */
  followThroughTitle: string;
  followThroughSubtitle: string;
  /** Human cadence wording for the Moment 4 confirmation. */
  cadence: string;
  /**
   * The assistant's model of the user AFTER the port — short noun-phrase facts,
   * not conversational bullets. This is the "yours" side of the generic→yours
   * transform: what the assistant now knows that it didn't 30 seconds ago.
   */
  ownedKnowledge: string[];
  /**
   * The living "what I know about you" profile, tagged by the moment each fact
   * was learned. Drives the accumulating-profile artifact: render entries with
   * `moment <= throughMoment` to show the profile growing across the rail. This
   * is the durable "yours" object — the one thing that is unmistakably theirs,
   * and the thing no existing surface type currently represents.
   */
  profile: { moment: 1 | 2 | 3 | 4; fact: string }[];
}

/**
 * The assistant everyone starts with, before any porting. Deliberately bland —
 * the contrast against `ownedKnowledge` IS the wow. Shared across personas
 * because the generic starting point is the same for everyone; that sameness is
 * the point ("this is what everyone gets; here's what became yours").
 */
export const GENERIC_ASSISTANT_KNOWLEDGE: string[] = [
  "Answers questions",
  "Helps with general tasks",
  "Looks things up",
  "Knows nothing about you yet",
];

export const PERSONA_PORTER: ActivationPersona = {
  key: "porter",
  label: "Persona 1 · Inbox porter",
  priorAssistant: "ChatGPT",
  pastedContext:
    "I'm a founder, mostly heads-down on fundraising right now. My inbox is a disaster — investor threads buried under newsletters and receipts. We're in early acquisition talks I haven't told the team about yet. Maya (maya@example.com) is my exec assistant, protect anything from her. There's an open TCG reimbursement (ref 49747972) I keep forgetting to chase.",
  specifics: [
    "You called the acquisition talks 'nothing yet' — sounds real enough to keep off email; I'll hold them to this chat.",
    "Investor threads are the signal; newsletters and receipts are the noise you want gone.",
    "Maya (maya@example.com) is protected — nothing from her gets touched.",
    "You're tracking an open TCG reimbursement (ref 49747972) you keep losing.",
  ],
  proposeAnchor: "investor threads buried under newsletters and receipts",
  outcomeTitle: "Clear the noise, surface the investor threads",
  outcomeBody:
    "Archive newsletters and receipts older than 30 days, protect anything from Maya, and pull the investor threads that need a reply to the top.",
  followThroughTitle: "Draft the two investor replies",
  followThroughSubtitle:
    "Prep responses to the threads from the cleanup — including the TCG reimbursement chase — for your review, nothing sent.",
  cadence: "Weekdays at 7:30 AM",
  ownedKnowledge: [
    "Founder, fundraising mode — heads-down",
    "Maya (maya@example.com) — protected, never touched",
    "Tracking TCG reimbursement, ref 49747972",
    "Inbox = investor signal buried under newsletter noise",
    "Confidential acquisition talks — kept private",
  ],
  profile: [
    { moment: 1, fact: "Founder, fundraising mode — heads-down" },
    { moment: 1, fact: "Maya = protected, never archived" },
    { moment: 1, fact: "Tracking TCG reimbursement 49747972" },
    { moment: 2, fact: "Wants investor threads surfaced first" },
    { moment: 3, fact: "Archived 31 newsletters/receipts · TCG surfaced" },
    { moment: 4, fact: "Daily 7:30 AM — learning the reply angle you want" },
  ],
};

export const PERSONA_PLANNER: ActivationPersona = {
  key: "planner",
  label: "Persona 2 · Calendar planner",
  priorAssistant: "Claude",
  pastedContext:
    "PM at a mid-size company. My weeks get eaten by status syncs and I never protect time for the actual roadmap writing. I have a partner review with Bob every Friday that's basically immovable. I want my mornings back for deep work. Also I run a Monday standup at 9 that I prep for in a rush every week.",
  specifics: [
    "Status syncs are eating the week — the roadmap writing is what keeps getting squeezed out.",
    "Mornings are the deep-work block you want to defend.",
    "The Friday partner review with Bob is fixed; everything else is negotiable.",
    "Monday 9 AM standup is a recurring scramble you'd like prepped ahead.",
  ],
  proposeAnchor: "mornings back for deep work",
  outcomeTitle: "Protect your mornings for roadmap writing",
  outcomeBody:
    "Move low-value status syncs out of the morning, leave the Friday review with Bob untouched, and block two deep-work windows before noon.",
  followThroughTitle: "Prep your Monday standup ahead of time",
  followThroughSubtitle:
    "Pull blockers and roadmap updates into a draft before 9 AM Monday so the standup isn't a scramble.",
  cadence: "Sunday evenings at 6:00 PM",
  ownedKnowledge: [
    "PM — roadmap writing keeps getting squeezed out",
    "Mornings = the deep-work block to defend",
    "Friday partner review with Bob is fixed, immovable",
    "Monday 9 AM standup is a weekly scramble",
    "Status syncs are the thing eating the week",
  ],
  profile: [
    { moment: 1, fact: "PM — roadmap writing keeps getting squeezed" },
    { moment: 1, fact: "Mornings = deep-work block to defend" },
    { moment: 1, fact: "Friday review with Bob is fixed" },
    { moment: 2, fact: "Wants mornings protected first" },
    { moment: 3, fact: "Moved 4 syncs · 5 focus blocks protected" },
    { moment: 4, fact: "Sunday 6 PM — learning your standup format" },
  ],
};

export const ACTIVATION_PERSONAS: ActivationPersona[] = [
  PERSONA_PORTER,
  PERSONA_PLANNER,
];

// ---------------------------------------------------------------------------
// Surface factories. Each returns a real `Surface` shaped to its production
// schema so the stories render the actual components through `SurfaceRouter`.
// ---------------------------------------------------------------------------

function sid(persona: ActivationPersona, slug: string): string {
  return `activation-${persona.key}-${slug}`;
}

/** Moment 1.1 — Port offer card. */
export function portOfferSurface(persona: ActivationPersona): Surface {
  return {
    surfaceId: sid(persona, "port-offer"),
    surfaceType: "card",
    title: "Bring your context",
    data: {
      subtitle: "Two pastes. Stays local to you.",
      body: `The fastest way to make this yours instead of generic. Paste a short prompt into ${persona.priorAssistant}, drop the response back here, and I'll show you what I picked up.`,
    },
    actions: [
      { id: "copy-prompt", label: "Copy the prompt", style: "primary" },
      { id: "skip", label: "Skip, ask me instead", style: "secondary" },
    ],
  };
}

/** Moment 1.2 — Prompt block the user copies into their prior assistant. */
export function portPromptBlockSurface(persona: ActivationPersona): Surface {
  return {
    surfaceId: sid(persona, "port-prompt"),
    surfaceType: "copy_block",
    data: {
      label: `Paste this into ${persona.priorAssistant}`,
      language: "text",
      text: "Summarize what you know about my work style, recurring tasks, preferences, and the workflows a new assistant should carry forward. Keep it concise but specific.",
    },
  };
}

/** Moment 1.4 — Specifics-back card. The core ownership moment. */
export function specificsCardSurface(
  persona: ActivationPersona,
  bulletCount: 2 | 3 | 4 = persona.specifics.length as 2 | 3 | 4,
): Surface {
  const bullets = persona.specifics.slice(0, bulletCount);
  const thin = bulletCount === 2;
  const body = [
    ...bullets.map((b) => `- ${b}`),
    thin ? "\nThis is what I've got so far — tell me if I'm off." : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    surfaceId: sid(persona, "specifics"),
    surfaceType: "card",
    title: "Here's what I picked up",
    data: { body },
  };
}

/** Moment 1 Fallback A — outcome chooser (choice, single-select). */
export function fallbackOutcomeChooserSurface(
  persona: ActivationPersona,
): Surface {
  return {
    surfaceId: sid(persona, "fallback-chooser"),
    surfaceType: "choice",
    title: "What's on your plate right now?",
    data: {
      description: "Pick whichever feels closest.",
      options: [
        {
          id: "putting-off",
          title: "Something I've been putting off that I need to finish",
        },
        { id: "decision", title: "A decision I'm weighing" },
        {
          id: "recurring",
          title: "A recurring thing I want to stop forgetting",
        },
        { id: "research", title: "Something I'm researching" },
      ],
    },
  };
}

/** Moment 1 Fallback C — starter scenario (choice, single-select). */
export function fallbackStarterScenarioSurface(
  persona: ActivationPersona,
): Surface {
  return {
    surfaceId: sid(persona, "fallback-scenario"),
    surfaceType: "choice",
    title: "Want to try one of these together right now?",
    data: {
      description: "Each one runs on your real data — no setup first.",
      options: [
        {
          id: "calendar-prep",
          title: "Pull my calendar for tomorrow and draft prep notes",
          recommended: true,
        },
        {
          id: "inbox-triage",
          title: "Read my last 50 emails and tell me what's worth replying to",
        },
        {
          id: "slack-catchup",
          title: "Find the threads in Slack I missed yesterday",
        },
      ],
    },
  };
}

/** Moment 2.1 — single-outcome offer card. Subtitle anchors to a specific. */
export function proposeOfferSurface(persona: ActivationPersona): Surface {
  return {
    surfaceId: sid(persona, "propose-offer"),
    surfaceType: "card",
    title: persona.outcomeTitle,
    data: {
      subtitle: `You mentioned ${persona.proposeAnchor}.`,
      body: persona.outcomeBody,
    },
    actions: [
      { id: "accept", label: "Yes, do it", style: "primary" },
      { id: "alternatives", label: "What else could you do?", style: "secondary" },
    ],
  };
}

/** Moment 2.2 — alternatives list (list, single-select). */
export function proposeAlternativesSurface(
  persona: ActivationPersona,
  count: 2 | 3 = 3,
): Surface {
  const allItems = [
    {
      id: "recommended",
      title: persona.outcomeTitle,
      subtitle: `Anchored to ${persona.proposeAnchor}.`,
      selected: true,
    },
    {
      id: "alt-1",
      title:
        persona.key === "porter"
          ? "Just unsubscribe me from the worst senders"
          : "Only protect Friday's deep-work block",
      subtitle:
        persona.key === "porter"
          ? "Narrower: kills recurring noise without touching threads."
          : "Narrower: one block, leaves the rest of the week as-is.",
    },
    {
      id: "alt-2",
      title:
        persona.key === "porter"
          ? "Build me a VIP-only inbox view"
          : "Reschedule everything around the roadmap",
      subtitle:
        persona.key === "porter"
          ? "Bigger lift: a filtered view you check once a day."
          : "Bigger lift: a full weekly rebuild, more to review.",
    },
  ];
  return {
    surfaceId: sid(persona, "propose-alternatives"),
    surfaceType: "list",
    title: "Other ways I could start",
    data: {
      selectionMode: "single",
      items: allItems.slice(0, count),
    },
    actions: [{ id: "run-selected", label: "Run this one", style: "primary" }],
  };
}

/** Moment 3.1 — OAuth inline (oauth_connect), only when needed. */
export function runOAuthSurface(persona: ActivationPersona): Surface {
  return {
    surfaceId: sid(persona, "run-oauth"),
    surfaceType: "oauth_connect",
    title: persona.key === "porter" ? "Connect Google" : "Connect Google Calendar",
    data: {
      providerKey: "google",
      displayName: "Google",
      description:
        persona.key === "porter"
          ? "Connect Gmail so I can clear the noise on your real inbox."
          : "Connect Calendar so I can reshape your real week.",
    },
  };
}

/** Moment 3.2 — task-progress card. `step` selects which frame to render. */
export function runTaskProgressSurface(
  persona: ActivationPersona,
  step: "all-pending" | "mid-run" | "done" | "failed",
): Surface {
  const stepsByPersona =
    persona.key === "porter"
      ? [
          { id: "scan", label: "Reading your inbox" },
          { id: "protect", label: "Protecting Maya + investor senders" },
          { id: "archive", label: "Archiving newsletters and receipts" },
          { id: "surface", label: "Surfacing threads that need a reply" },
        ]
      : [
          { id: "read", label: "Reading your calendar" },
          { id: "classify", label: "Sorting syncs from deep work" },
          { id: "protect", label: "Leaving Friday's review with Bob" },
          { id: "block", label: "Blocking two morning windows" },
        ];

  const statusFor = (index: number): { status: string; detail?: string } => {
    switch (step) {
      case "all-pending":
        return { status: "pending" };
      case "mid-run":
        if (index === 0) return { status: "completed" };
        if (index === 1)
          return {
            status: "in_progress",
            detail: persona.key === "porter" ? "47 messages read" : "18 events scanned",
          };
        return { status: "pending" };
      case "done":
        return { status: "completed" };
      case "failed":
        if (index < 2) return { status: "completed" };
        if (index === 2) return { status: "failed" };
        return { status: "pending" };
    }
  };

  const overall =
    step === "done" ? "completed" : step === "failed" ? "failed" : "in_progress";

  return {
    surfaceId: sid(persona, `run-progress-${step}`),
    surfaceType: "card",
    data: {
      title: persona.key === "porter" ? "Cleaning your inbox" : "Reshaping your week",
      template: "task_progress",
      templateData: {
        title: persona.key === "porter" ? "Cleaning your inbox" : "Reshaping your week",
        status: overall,
        steps: stepsByPersona.map((s, i) => ({ ...s, ...statusFor(i) })),
      },
    },
  };
}

/** Moment 3.3 — result as a plain `card` (spec §3.3 shape). */
export function runResultCardSurface(persona: ActivationPersona): Surface {
  if (persona.key === "porter") {
    return {
      surfaceId: sid(persona, "result-card"),
      surfaceType: "card",
      title: "Inbox triaged.",
      data: {
        subtitle: "2 need a reply, 38 archivable.",
        body: "Cleared newsletters and receipts, kept everything from Maya, and pulled the investor threads to the top — including the TCG reimbursement (ref 49747972).",
        metadata: [
          { label: "Archived", value: "31" },
          { label: "Protected", value: "Maya" },
          { label: "Needs reply", value: "2" },
        ],
      },
    };
  }
  return {
    surfaceId: sid(persona, "result-card"),
    surfaceType: "card",
    title: "Week reshaped.",
    data: {
      subtitle: "5 focus blocks protected, 1 decision left for you.",
      body: "Moved status syncs out of your mornings and left the Friday review with Bob untouched. One move needs your call because it affects an external attendee.",
      metadata: [
        { label: "Focus blocks", value: "5" },
        { label: "Conflicts fixed", value: "3" },
        { label: "Needs approval", value: "1" },
      ],
    },
  };
}

/** Moment 3.3 — same result as the shipped `work_result` surface, for comparison. */
export function runResultWorkResultSurface(persona: ActivationPersona): Surface {
  if (persona.key === "porter") {
    return {
      surfaceId: sid(persona, "result-work"),
      surfaceType: "work_result",
      title: "Inbox triaged",
      data: {
        status: "completed",
        summary:
          "Cleared newsletters and receipts, kept everything from Maya, and pulled the investor threads to the top.",
        metrics: [
          { label: "Archived", value: 31, tone: "positive" },
          { label: "Protected", value: "Maya", tone: "neutral" },
          { label: "Needs reply", value: 2, tone: "warning" },
        ],
        sections: [
          {
            id: "attention",
            title: "Needs a reply",
            type: "items",
            items: [
              {
                id: "tcg",
                title: "TCG reimbursement chase",
                description: "Open ref 49747972 you keep losing — drafted below.",
                status: "Reply today",
                tone: "warning",
              },
              {
                id: "investor",
                title: "Investor thread: Series A timing",
                description: "Buried under newsletters; surfaced to the top.",
                status: "Reply today",
                tone: "warning",
              },
            ],
          },
        ],
      },
    };
  }
  return {
    surfaceId: sid(persona, "result-work"),
    surfaceType: "work_result",
    title: "Week reshaped",
    data: {
      status: "completed",
      summary:
        "Moved status syncs out of your mornings and left the Friday review with Bob untouched.",
      metrics: [
        { label: "Focus blocks", value: 5, tone: "positive" },
        { label: "Conflicts fixed", value: 3, tone: "positive" },
        { label: "Needs approval", value: 1, tone: "warning" },
      ],
      sections: [
        {
          id: "changes",
          title: "What changed",
          type: "timeline",
          items: [
            {
              id: "mornings",
              title: "Protected two morning blocks",
              description: "Moved Mon/Wed syncs to the afternoon.",
              tone: "positive",
            },
            {
              id: "friday",
              title: "Left Friday review with Bob unchanged",
              description: "Moving it would collide with an external attendee.",
              tone: "warning",
              status: "Ask first",
            },
          ],
        },
      ],
    },
  };
}

/** Moment 3.4 — confirmation surface for a destructive action. */
export function runConfirmationSurface(persona: ActivationPersona): Surface {
  return {
    surfaceId: sid(persona, "run-confirm"),
    surfaceType: "confirmation",
    title: persona.key === "porter" ? "Archive 31 threads?" : "Move 4 meetings?",
    data: {
      message:
        persona.key === "porter"
          ? "Archive the 31 newsletters and receipts older than 30 days."
          : "Move the 4 status syncs out of your morning blocks.",
      detail: "Reversible — everything stays searchable and can be moved back.",
      confirmLabel: persona.key === "porter" ? "Archive them" : "Move them",
      cancelLabel: "Not yet",
      destructive: true,
    },
    actions: [
      {
        id: "confirm",
        label: persona.key === "porter" ? "Archive them" : "Move them",
        style: "destructive",
      },
      { id: "cancel", label: "Not yet", style: "secondary" },
    ],
  };
}

/** Moment 4.1 — follow-through list (list, single-select). */
export function followThroughListSurface(persona: ActivationPersona): Surface {
  const second =
    persona.key === "porter"
      ? {
          id: "briefing",
          title: "Make this a morning inbox briefing",
          subtitle: "A lighter version of the cleanup every weekday.",
        }
      : {
          id: "weekly-rebuild",
          title: "Reshape my week every Sunday",
          subtitle: "Run the same protection pass before the week starts.",
        };
  return {
    surfaceId: sid(persona, "follow-list"),
    surfaceType: "list",
    title: "Next best move",
    data: {
      selectionMode: "single",
      items: [
        {
          id: "primary",
          title: persona.followThroughTitle,
          subtitle: persona.followThroughSubtitle,
          selected: true,
        },
        second,
      ],
    },
    actions: [
      { id: "set-up", label: "Set it up", style: "primary" },
      { id: "not-now", label: "Not now", style: "secondary" },
    ],
  };
}

/** Moment 4.2 — cadence confirmation. `edited` toggles the inferred time. */
export function followThroughCadenceSurface(
  persona: ActivationPersona,
  edited = false,
): Surface {
  const cadence = edited
    ? persona.key === "porter"
      ? "Weekdays at 8:15 AM"
      : "Sunday evenings at 7:30 PM"
    : persona.cadence;
  return {
    surfaceId: sid(persona, `cadence${edited ? "-edited" : ""}`),
    surfaceType: "confirmation",
    title: "Set the cadence",
    data: {
      message: `Run this ${cadence.toLowerCase()}, and I'll get sharper at picking the angle you actually want.`,
      detail: "You can change the time or turn it off anytime.",
      confirmLabel: "Lock it in",
      cancelLabel: "Change time",
    },
    actions: [
      { id: "confirm", label: "Lock it in", style: "primary" },
      { id: "cancel", label: "Change time", style: "secondary" },
    ],
  };
}
