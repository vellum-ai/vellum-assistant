"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "shipping-soon", label: "Shipping soon", level: 2 },
  { id: "up-next", label: "Up next", level: 2 },
  { id: "on-the-horizon", label: "On the horizon", level: 2 },
  { id: "exploring", label: "Exploring", level: 2 },
  { id: "the-fine-print", label: "The fine print", level: 2 },
];

const LAST_UPDATED = "April 22, 2026";

type Item = {
  emoji: string;
  title: string;
  description: string;
};

const SHIPPING_SOON: Item[] = [
  {
    emoji: "\u{1FA84}",
    title: "Teleport",
    description:
      "Your assistant doesn't go dark when your laptop closes. Move seamlessly between local and cloud — same memory, same identity, same conversations.",
  },
  {
    emoji: "\u{1F310}",
    title: "Cross-channel context",
    description:
      "Start a conversation on desktop, continue it on Slack, finish it on your phone. One assistant, one memory, wherever you are.",
  },
  {
    emoji: "\u{1F527}",
    title: "Setup, upgrade, recovery",
    description:
      "First-run should feel like meeting someone, not configuring software. Smoother installs, safer upgrades, and a recovery path when something goes sideways.",
  },
  {
    emoji: "\u{2709}\u{FE0F}",
    title: "Email autonomy",
    description:
      "Your assistant drafts, replies, and handles routine email on its own — with the guardrails you set. You stay in the loop; it does the busywork.",
  },
  {
    emoji: "\u{1F3A5}",
    title: "Google Meet",
    description:
      "Join meetings, take notes, track action items, and pull them into your to-dos — without another tab to manage.",
  },
];

const UP_NEXT: Item[] = [
  {
    emoji: "\u{1F4F1}",
    title: "iOS app",
    description:
      "A real mobile assistant, not a wrapper. Native iOS, push notifications that matter, and the same memory your desktop assistant has.",
  },
  {
    emoji: "\u{1F30D}",
    title: "Web app",
    description:
      "Access your assistant from any browser, on any device, without an install. Same assistant, zero friction.",
  },
  {
    emoji: "\u{1F916}",
    title: "Slack autopilot",
    description:
      "Full Slack presence — your assistant watches the channels you care about, replies where you'd want it to, and escalates the rest.",
  },
  {
    emoji: "\u{1F512}",
    title: "Permissions, rebuilt",
    description:
      "A permissions model that's both safer and less annoying. Clear defaults, granular overrides, and no more guessing what you approved a week ago.",
  },
  {
    emoji: "\u{23F0}",
    title: "Schedules without tokens",
    description:
      "Recurring tasks and check-ins that don't break when an API token expires. Reliable background work, handled behind the scenes.",
  },
  {
    emoji: "\u{1F3AF}",
    title: "Personalization",
    description:
      "Your assistant adapts to how you work — tone, habits, preferences, the people you talk to. It gets more yours the longer you use it.",
  },
  {
    emoji: "\u{1F9F9}",
    title: "Automatic context compaction",
    description:
      "Long conversations stop hitting a wall. Your assistant keeps the signal and drops the noise, automatically.",
  },
  {
    emoji: "\u{1F9E0}",
    title: "Subagents",
    description:
      "Your assistant delegates to specialized helpers in parallel — research, coding, writing — and brings the results back to you.",
  },
  {
    emoji: "\u{1F4C8}",
    title: "Automatic self-improvement",
    description:
      "Your assistant notices when it got something wrong and quietly gets better at it. No fine-tuning pipeline required.",
  },
  {
    emoji: "\u{1FA7A}",
    title: "Vellum Doctor",
    description:
      "A built-in diagnostic that tells you what's broken and how to fix it — before you have to ask.",
  },
  {
    emoji: "\u{1F4BB}",
    title: "Better CLI",
    description:
      "Power-user shortcuts, scriptable commands, and a faster path for developers who want to drive Vellum from the terminal.",
  },
  {
    emoji: "\u{1F4EC}",
    title: "Native email accounts",
    description:
      "Assistants can own their own email accounts, not just borrow yours. Real identity, real inbox, real separation of concerns.",
  },
  {
    emoji: "\u{2B50}",
    title: "Vellum Pro plan",
    description:
      "A paid tier for heavy users and small teams — higher limits, priority support, and features built for people who use Vellum every day.",
  },
  {
    emoji: "\u{1F5FA}\u{FE0F}",
    title: "Roadmap in docs",
    description:
      "The page you're reading. Public, evolving, and honest about what we're building next.",
  },
];

const ON_THE_HORIZON: Item[] = [
  {
    emoji: "\u{1F399}\u{FE0F}",
    title: "Real-time voice",
    description:
      "Talk to your assistant out loud, interrupt it, and have it talk back — with low enough latency that it feels like a real conversation.",
  },
  {
    emoji: "\u{1F4DE}",
    title: "Phone calls",
    description:
      "Your assistant can take and make phone calls on your behalf — screening, scheduling, and handling the calls you don't want to.",
  },
  {
    emoji: "\u{1F49A}",
    title: "Health & wellness",
    description:
      "Pull signals from the wearables you already have and turn them into useful nudges, not a dashboard you have to check.",
  },
  {
    emoji: "\u{1F50D}",
    title: "PR review",
    description:
      "Your assistant reviews pull requests with your standards, catches regressions, and flags the things you'd catch yourself.",
  },
  {
    emoji: "\u{1F3D7}\u{FE0F}",
    title: "Orchestrating coding agents",
    description:
      "One assistant that coordinates multiple coding agents across your repos — planning, delegating, and shipping end-to-end.",
  },
  {
    emoji: "\u{1F517}",
    title: "Webhooks",
    description:
      "Wire any service into your assistant with a simple webhook. If it can POST, your assistant can react to it.",
  },
  {
    emoji: "\u{1F680}",
    title: "Public apps & shareable pages",
    description:
      "Ship something your assistant built with a single share link — dashboards, tools, little apps — no deploy step required.",
  },
  {
    emoji: "\u{1F91D}",
    title: "Skill sharing",
    description:
      "A community hub for teaching your assistant new tricks. Pull in skills others have built; publish your own.",
  },
  {
    emoji: "\u{1F465}",
    title: "Multiple assistants per user",
    description:
      "A work assistant and a personal assistant. Or one per project. Separate memories, separate identities, same you.",
  },
  {
    emoji: "\u{1F4CD}",
    title: "Location services",
    description:
      "Your assistant knows where you are (when you want it to) and acts accordingly — timezone-smart, traffic-aware, context-aware.",
  },
  {
    emoji: "\u{1F4B3}",
    title: "Agentic payments",
    description:
      "Your assistant buys the flight, renews the domain, tops up the subscription — within limits you set and receipts you can audit.",
  },
  {
    emoji: "\u{1F4AC}",
    title: "Assistant-to-assistant",
    description:
      "Your assistant can talk to other assistants — coordinating schedules, sharing context, negotiating on your behalf.",
  },
  {
    emoji: "\u{1F426}",
    title: "Twitter & social",
    description:
      "Draft, schedule, and publish to your socials — in your voice, with your edits, never without your sign-off.",
  },
  {
    emoji: "\u{1F4DD}",
    title: "SEO content workflow",
    description:
      "From keyword to published post, your assistant runs the whole content loop — while you stay the editor-in-chief.",
  },
  {
    emoji: "\u{1F440}",
    title: "Team visibility",
    description:
      "Shared context across a team, without sharing a single assistant. Your memory stays yours; the work gets coordinated.",
  },
];

const EXPLORING: Item[] = [
  {
    emoji: "\u{1F4AC}",
    title: "iMessage",
    description:
      "A native Apple-ecosystem channel for your assistant — texts, read receipts, the works.",
  },
  {
    emoji: "\u{1F4B0}",
    title: "Personal finance",
    description:
      "Your money, summarized and acted on. Categorization, alerts, and small automations you'd actually run.",
  },
  {
    emoji: "\u{1F9EC}",
    title: "Own weights",
    description:
      "Models fine-tuned on you, with you. A long-term path toward an assistant that's truly yours at the model layer.",
  },
  {
    emoji: "\u{231A}",
    title: "Apple Watch",
    description:
      "Your assistant on your wrist — glanceable, taptic, and ambient.",
  },
  {
    emoji: "\u{1F4E1}",
    title: "Presence detection",
    description:
      "Your assistant knows when you're at your desk, in a meeting, or asleep — and behaves accordingly.",
  },
  {
    emoji: "\u{1F3A4}",
    title: "Voice activation",
    description:
      "Wake-word access so your assistant is one phrase away, not one click away.",
  },
  {
    emoji: "\u{1F5A5}\u{FE0F}",
    title: "Ambient context",
    description:
      "Your assistant can see what's on your screen when you ask it to — so \"this\" and \"that\" actually mean something.",
  },
  {
    emoji: "\u{26A1}",
    title: "Use Vellum in any app",
    description:
      "Summon your assistant inside any app on your system — summarize a doc, reply to a message, translate a selection — without switching windows.",
  },
  {
    emoji: "\u{1F9D1}\u{200D}\u{1F4BB}",
    title: "Open-source coding models",
    description:
      "First-class support for running coding tasks on open-source models you control.",
  },
  {
    emoji: "\u{2728}",
    title: "Dynamic visual presence",
    description:
      "An assistant that can show up where it's useful — a floating panel, an inline overlay, a quiet notification — and get out of the way when it isn't.",
  },
  {
    emoji: "\u{1F5C4}\u{FE0F}",
    title: "Custom app backends",
    description:
      "Let the apps your assistant builds talk to real backends you own, securely.",
  },
  {
    emoji: "\u{1F3E0}",
    title: "Personal life automation",
    description:
      "The small recurring stuff — birthdays, renewals, reservations, errands — handled without a spreadsheet.",
  },
  {
    emoji: "\u{1F3A8}",
    title: "Custom assistant skins",
    description:
      "Make your assistant look and feel the way you want it to. Themes, avatars, and the small cosmetic details that make something feel like yours.",
  },
  {
    emoji: "\u{1F4E6}",
    title: "Local containerization",
    description:
      "A stronger security boundary between your assistant and the rest of your system, for users who want extra peace of mind.",
  },
  {
    emoji: "\u{260E}\u{FE0F}",
    title: "Managed phone numbers",
    description:
      "Your assistant gets its own phone number, managed by us, ready to call and text on your behalf.",
  },
];

function TierList({ items }: { items: Item[] }) {
  return (
    <ul className="mb-10 list-none divide-y divide-stone-200 border-t border-b border-stone-200 p-0 dark:divide-moss-600/50 dark:border-moss-600/50">
      {items.map((item) => (
        <li key={item.title} className="m-0 py-4 pl-0">
          <h4 className="mt-0 mb-1 font-sans text-base font-semibold text-stone-900 dark:text-stone-100">
            <span className="mr-2">{item.emoji}</span>
            {item.title}
          </h4>
          <p className="m-0 text-sm leading-snug text-stone-600 dark:text-stone-400">
            {item.description}
          </p>
        </li>
      ))}
    </ul>
  );
}

export function RoadmapContent() {
  return (
    <>
      <DocsContent title="Roadmap" breadcrumb="Docs / Roadmap">
        <p className="mb-2 text-xs text-stone-400 dark:text-stone-500">
          Last updated on {LAST_UPDATED}
        </p>
        <p className="mb-4 text-stone-600 dark:text-stone-400">
          What we&apos;re building next, grouped by how close it is to shipping.
        </p>
        <p className="mb-8 text-stone-600 dark:text-stone-400">
          Vellum is moving fast. This page shows where things stand. We update
          it as priorities shift, so check back.
        </p>

        <section id="shipping-soon">
          <SectionHeading id="shipping-soon" level={2}>
            Shipping soon
          </SectionHeading>
          <p className="mb-6 text-stone-600 dark:text-stone-400">
            Engineering-complete or nearly so. Finalizing for rollout.
          </p>
          <TierList items={SHIPPING_SOON} />
        </section>

        <section id="up-next">
          <SectionHeading id="up-next" level={2}>
            Up next
          </SectionHeading>
          <p className="mb-6 text-stone-600 dark:text-stone-400">
            In progress now. These are the things that unlock a meaningfully
            better day-to-day.
          </p>
          <TierList items={UP_NEXT} />
        </section>

        <section id="on-the-horizon">
          <SectionHeading id="on-the-horizon" level={2}>
            On the horizon
          </SectionHeading>
          <p className="mb-6 text-stone-600 dark:text-stone-400">
            Expect motion here in the coming weeks.
          </p>
          <TierList items={ON_THE_HORIZON} />
        </section>

        <section id="exploring">
          <SectionHeading id="exploring" level={2}>
            Exploring
          </SectionHeading>
          <p className="mb-6 text-stone-600 dark:text-stone-400">
            Ideas we&apos;re excited about but not ready to commit timing on.
            Directionally yes, specifically TBD.
          </p>
          <TierList items={EXPLORING} />
        </section>

        <section id="the-fine-print" className="mt-12">
          <SectionHeading id="the-fine-print" level={2}>
            The fine print
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            Polish, bug fixes, and security improvements are a standing commitment
            — a meaningful slice of every team&apos;s capacity goes here, always.
            That work doesn&apos;t show up on this page, but it ships continuously.
          </p>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            Priorities shift. Dates move. Some items will merge, some will split,
            some will get dropped. This page changes with us. If there&apos;s
            something you want to see sooner, tell us — we read every note.
          </p>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            Want to share feedback on our Roadmap? Drop us a note in{" "}
            <a
              href="https://discord.com/invite/ZABd9V2zM8"
              target="_blank"
              rel="noopener noreferrer"
            >
              Discord
            </a>
            .
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
