"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  {
    id: "why-scheduling-matters",
    label: "Why scheduling matters",
    level: 2,
  },
  {
    id: "types-of-scheduled-work",
    label: "Types of scheduled work",
    level: 2,
  },
  { id: "one-shot-schedules", label: "One-shot schedules", level: 3 },
  { id: "recurring-schedules", label: "Recurring schedules", level: 3 },
  { id: "heartbeats", label: "Heartbeats", level: 3 },
  { id: "watchers", label: "Watchers", level: 3 },
  { id: "playbooks", label: "Playbooks", level: 3 },
  { id: "subagents", label: "Subagents", level: 3 },
  { id: "schedule-modes", label: "Schedule modes", level: 2 },
  { id: "notification-routing", label: "Notification routing", level: 2 },
  { id: "schedule-lifecycle", label: "Schedule lifecycle", level: 2 },
  { id: "use-cases", label: "Use cases", level: 2 },
  {
    id: "how-scheduling-connects-to-other-concepts",
    label: "How scheduling connects to other concepts",
    level: 2,
  },
  {
    id: "what-happens-when-youre-away",
    label: "What happens when you're away",
    level: 2,
  },
  {
    id: "setting-up-a-schedule",
    label: "Setting up a schedule",
    level: 2,
  },
];

export function SchedulingContent() {
  return (
    <>
      <DocsContent
        title="Scheduling"
        breadcrumb="Docs / Key Concepts / Scheduling"
      >
        <p className="mb-4 text-zinc-600">
          Your assistant doesn&apos;t just respond when you talk to it. It can
          also work on its own, on a schedule you define. Scheduling lets you
          set up tasks that run automatically: once at a specific time, or
          repeatedly on a cadence.
        </p>
        <p className="mb-8 text-zinc-600">
          Think of it as giving your assistant a calendar of its own. Instead
          of waiting for you to ask, it can check things, send things, and
          surface things proactively.
        </p>

        {/* ── Why scheduling matters ───────────────────────────────── */}
        <section id="why-scheduling-matters">
          <SectionHeading id="why-scheduling-matters" level={2}>
            Why scheduling matters
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Most AI assistants are purely reactive. You ask, they answer. But
            a lot of useful work is repetitive and time-based: checking for
            updates, sending reminders, generating reports, following up on
            things that went quiet.
          </p>
          <p className="mb-0 text-zinc-600">
            Scheduling turns your assistant from something you talk to into
            something that works for you in the background. It&apos;s the
            difference between a tool you pick up and an assistant that&apos;s
            actually assisting.
          </p>
        </section>

        {/* ── Types of scheduled work ──────────────────────────────── */}
        <section id="types-of-scheduled-work" className="mt-12">
          <SectionHeading id="types-of-scheduled-work" level={2}>
            Types of scheduled work
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            There are several flavors of automated work, each suited to
            different needs.
          </p>

          {/* One-shot */}
          <div id="one-shot-schedules" className="mb-10">
            <SectionHeading id="one-shot-schedules" level={3}>
              One-shot schedules
            </SectionHeading>
            <p className="mb-4 text-zinc-600">
              A single task that fires at a specific time. You give it an ISO
              8601 timestamp and a message. It fires once, then is
              automatically marked as{" "}
              <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
                fired
              </code>{" "}
              and disabled. This is what used to be called &ldquo;reminders&rdquo;.
              Now it&apos;s a unified concept.
            </p>
            <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
              <li>
                &ldquo;Remind me to call the dentist tomorrow at 9am&rdquo;
              </li>
              <li>
                &ldquo;Send Alice a follow-up email on Friday if they
                haven&apos;t replied&rdquo;
              </li>
              <li>
                &ldquo;Check the deployment status in 30 minutes and let me
                know&rdquo;
              </li>
            </ul>
          </div>

          {/* Recurring */}
          <div id="recurring-schedules" className="mb-10">
            <SectionHeading id="recurring-schedules" level={3}>
              Recurring schedules
            </SectionHeading>
            <p className="mb-4 text-zinc-600">
              Tasks that repeat on a cadence. Under the hood, these use
              standard cron expressions (5-field) or RRULE recurrence rules
              (RFC 5545), but you don&apos;t need to know that: just describe
              what you want in plain language and the assistant translates it.
            </p>
            <p className="mb-4 text-zinc-600">
              RRULE supports advanced patterns that cron can&apos;t:
              bounded recurrence (
              <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
                COUNT=30
              </code>{" "}
              or{" "}
              <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
                UNTIL=...
              </code>
              ), set constructs with{" "}
              <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
                RDATE
              </code>{" "}
              /{" "}
              <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
                EXDATE
              </code>{" "}
              /{" "}
              <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
                EXRULE
              </code>{" "}
              for adding or excluding specific dates, and union patterns
              with multiple{" "}
              <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
                RRULE
              </code>{" "}
              lines.
            </p>
            <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
              <li>
                &ldquo;Every morning at 8am, give me a summary of my calendar
                and unread emails&rdquo;
              </li>
              <li>
                &ldquo;Every Friday afternoon, compile a weekly status update
                from my Slack activity&rdquo;
              </li>
              <li>
                &ldquo;On the 1st of each month, remind me to review my
                subscriptions&rdquo;
              </li>
              <li>
                &ldquo;Every weekday except holidays&rdquo; (daily minus
                specific EXDATE entries)
              </li>
            </ul>
          </div>

          {/* Heartbeats */}
          <div id="heartbeats" className="mb-10">
            <SectionHeading id="heartbeats" level={3}>
              Heartbeats
            </SectionHeading>
            <p className="mb-4 text-zinc-600">
              A heartbeat is a periodic background checklist. Your assistant
              runs through the items in{" "}
              <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
                HEARTBEAT.md
              </code>{" "}
              at a configurable interval and only surfaces things when they
              need your attention. It runs in a separate background
              conversation, not your active chat.
            </p>
            <p className="mb-4 text-zinc-600">
              Configuration lives in{" "}
              <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
                config.json
              </code>
              :
            </p>
            <ul className="mb-4 list-disc space-y-1 pl-6 text-zinc-600">
              <li>
                <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
                  heartbeat.enabled
                </code>:
                toggle on/off (requires restart)
              </li>
              <li>
                <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
                  heartbeat.intervalMs
                </code>:
                milliseconds between runs (default: 1 hour)
              </li>
              <li>
                <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
                  heartbeat.activeHoursStart
                </code>{" "}
                /{" "}
                <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
                  activeHoursEnd
                </code>:
                restrict runs to certain hours (0–23, both must be set
                together)
              </li>
            </ul>
            <p className="mb-0 text-zinc-600">
              The default checklist focuses on your user relationship:
              reviewing the scratchpad, thinking about follow-ups from recent
              conversations, and reaching out when there&apos;s something
              worth sharing. You can customize{" "}
              <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
                HEARTBEAT.md
              </code>{" "}
              to check whatever you want, and changes take effect on the next
              run without a restart.
            </p>
          </div>

          {/* Watchers */}
          <div id="watchers" className="mb-10">
            <SectionHeading id="watchers" level={3}>
              Watchers
            </SectionHeading>
            <p className="mb-4 text-zinc-600">
              Watchers are a polling-based monitoring system for external
              services. Instead of running on a fixed schedule with a message,
              a watcher polls a specific provider for new events and processes
              them with an action prompt you define.
            </p>
            <p className="mb-4 text-zinc-600">
              Each watcher has:
            </p>
            <ul className="mb-4 list-disc space-y-1 pl-6 text-zinc-600">
              <li>
                <strong>Provider</strong>: the external service to
                poll (Gmail, Outlook, GitHub, Google Calendar, Outlook
                Calendar, or Linear)
              </li>
              <li>
                <strong>Action prompt</strong>: LLM instructions for handling
                detected events
              </li>
              <li>
                <strong>Poll interval</strong>: how often to check (minimum
                15 seconds, default 60 seconds)
              </li>
              <li>
                <strong>Watermark</strong>: tracks what&apos;s already been
                seen so events are never processed twice
              </li>
            </ul>
            <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
              <li>
                &ldquo;Watch my Gmail for important emails and notify me
                immediately&rdquo;
              </li>
              <li>
                &ldquo;Monitor this GitHub repo for new issues assigned to
                me&rdquo;
              </li>
              <li>
                &ldquo;Watch my Google Calendar and alert me 10 minutes before
                meetings&rdquo;
              </li>
              <li>
                &ldquo;Track new Linear issues in the Engineering project&rdquo;
              </li>
              <li>
                &ldquo;Watch my Outlook inbox for messages from my
                manager&rdquo;
              </li>
            </ul>
          </div>

          {/* Playbooks */}
          <div id="playbooks">
            <SectionHeading id="playbooks" level={3}>
              Playbooks
            </SectionHeading>
            <p className="mb-4 text-zinc-600">
              Playbooks are trigger-action automation rules, not time-based
              like schedules, but event-based. They tell your assistant how to
              handle incoming messages that match a pattern.
            </p>
            <p className="mb-4 text-zinc-600">
              Each playbook has:
            </p>
            <ul className="mb-4 list-disc space-y-1 pl-6 text-zinc-600">
              <li>
                <strong>Trigger</strong>: pattern or description that
                activates the rule
              </li>
              <li>
                <strong>Action</strong>: what to do when triggered (natural
                language)
              </li>
              <li>
                <strong>Channel</strong>: which channel it applies to (
                <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
                  *
                </code>{" "}
                for all, or a specific channel)
              </li>
              <li>
                <strong>Autonomy level</strong>:{" "}
                <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
                  auto
                </code>{" "}
                (execute immediately),{" "}
                <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
                  draft
                </code>{" "}
                (prepare for review), or{" "}
                <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
                  notify
                </code>{" "}
                (alert only)
              </li>
              <li>
                <strong>Priority</strong>: numeric priority for overlapping
                rules (higher wins)
              </li>
            </ul>
            <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
              <li>
                &ldquo;When I get a meeting request, draft a polite
                decline&rdquo;
              </li>
              <li>
                &ldquo;When someone messages me on Slack with &lsquo;urgent&rsquo;,
                notify me on Telegram immediately&rdquo;
              </li>
              <li>
                &ldquo;When an email comes from my boss, auto-flag it as
                important&rdquo;
              </li>
            </ul>
          </div>

          {/* Subagents */}
          <div id="subagents" className="mt-10">
            <SectionHeading id="subagents" level={3}>
              Subagents
            </SectionHeading>
            <p className="mb-4 text-zinc-600">
              Subagents are the on-demand cousin to scheduled work.
              Instead of running on a cadence or in response to an
              external event, they spin up immediately when your
              assistant needs to do something in parallel and report
              back later.
            </p>
            <p className="mb-4 text-zinc-600">
              Each subagent runs in its own isolated context with its
              own role (research, coding, planning, etc.) and a
              specific task to complete. The parent assistant keeps
              chatting with you while the subagent works in the
              background. When it&apos;s done, results stream back so
              your assistant can use them.
            </p>
            <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
              <li>
                &ldquo;Spawn a research subagent to dig into competitor
                pricing while we keep planning the launch&rdquo;
              </li>
              <li>
                &ldquo;Run three coding subagents in parallel, one per
                refactor target&rdquo;
              </li>
              <li>
                &ldquo;Kick off a planning subagent for the Q3 roadmap
                draft and bring it back when ready&rdquo;
              </li>
            </ul>
            <p className="mb-0 text-zinc-600">
              Schedules vs. subagents:{" "}
              <strong>schedule</strong> = &ldquo;do this on a
              cadence&rdquo;, <strong>subagent</strong> = &ldquo;do
              this in parallel right now and report back.&rdquo; They
              compose: a recurring schedule can spawn subagents to
              fan out work each time it fires. See{" "}
              <a href="/docs/skills-reference/subagent">
                Subagent skill reference
              </a>{" "}
              for the full toolset.
            </p>
          </div>
        </section>

        {/* ── Schedule modes ───────────────────────────────────────── */}
        <section id="schedule-modes" className="mt-12">
          <SectionHeading id="schedule-modes" level={2}>
            Schedule modes
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Schedules (both one-shot and recurring) have four modes that
            control what happens when they fire:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Execute</strong> (default): sends the
              schedule&apos;s message to a background assistant
              conversation. The assistant processes it autonomously as if
              you had sent it. Use this for tasks that need the assistant
              to actually do something: &ldquo;check my calendar and send
              me a digest.&rdquo;
            </li>
            <li>
              <strong>Notify</strong>: sends a notification to you
              via the notification pipeline. No assistant processing
              occurs. Use this for simple reminders: &ldquo;remind me to
              take medicine at 9am.&rdquo;
            </li>
            <li>
              <strong>Script</strong>: runs a shell command on a
              cadence with no LLM in the loop. Stdout, stderr, and exit
              code are captured into the run record. Use this for cheap,
              deterministic background jobs (rotating logs, syncing a
              file, pinging an endpoint) where you don&apos;t need
              assistant reasoning.
            </li>
            <li>
              <strong>Wake</strong>: resumes an existing
              conversation with a hint message instead of spawning a new
              one. Useful when you want a long-running thread to pick
              itself back up later (&ldquo;wake this up tomorrow morning
              and continue the research&rdquo;) without losing the
              context you&apos;ve already built. Requires a target
              conversation ID.
            </li>
          </ul>
          <p className="mb-0 text-zinc-600">
            Execute-mode and wake-mode schedules run with full access to
            skills and tools, so the assistant can check your email, query
            APIs, build reports, anything it can do in a normal
            conversation. Script and notify modes skip the LLM entirely
            and are correspondingly cheap.
          </p>
        </section>

        {/* ── Notification routing ─────────────────────────────────── */}
        <section id="notification-routing" className="mt-12">
          <SectionHeading id="notification-routing" level={2}>
            Notification routing
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            When a schedule fires in notify mode, you can control where the
            notification goes:
          </p>
          <ul className="mb-4 list-disc space-y-1 pl-6 text-zinc-600">
            <li>
              <strong>All channels</strong> (default): deliver to every
              available channel
            </li>
            <li>
              <strong>Single channel</strong>: deliver to one specific channel
              (&ldquo;remind me on Telegram&rdquo;)
            </li>
            <li>
              <strong>Multi channel</strong>: deliver to a subset of channels
            </li>
          </ul>
          <p className="mb-0 text-zinc-600">
            You can also pass routing hints to influence delivery, for
            example, preferred channels or exclusions. Most of the time, the
            default (all channels) is what you want.
          </p>
        </section>

        {/* ── Schedule lifecycle ───────────────────────────────────── */}
        <section id="schedule-lifecycle" className="mt-12">
          <SectionHeading id="schedule-lifecycle" level={2}>
            Schedule lifecycle
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Every schedule moves through a set of statuses:
          </p>
          <ul className="mb-4 list-disc space-y-1 pl-6 text-zinc-600">
            <li>
              <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
                active
              </code>:
              enabled and waiting for the next trigger time
            </li>
            <li>
              <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
                firing
              </code>:
              currently executing
            </li>
            <li>
              <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
                fired
              </code>:
              one-shot schedule that has completed (automatically disabled)
            </li>
            <li>
              <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
                cancelled
              </code>:
              cancelled before it could fire
            </li>
          </ul>
          <p className="mb-4 text-zinc-600">
            Recurring schedules stay{" "}
            <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
              active
            </code>{" "}
            after each run and automatically compute the next trigger time.
            One-shot schedules transition to{" "}
            <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
              fired
            </code>{" "}
            after completing.
          </p>
          <p className="mb-0 text-zinc-600">
            Each run is recorded with its status, duration, output, and any
            errors. You can ask your assistant &ldquo;show me my
            schedules&rdquo; to see the full list with their statuses and
            recent run history.
          </p>
        </section>

        {/* ── Use cases ────────────────────────────────────────────── */}
        <section id="use-cases" className="mt-12">
          <SectionHeading id="use-cases" level={2}>
            Use cases
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            A few ways scheduling and automation come together:
          </p>
          <ul className="mb-0 list-disc space-y-4 pl-6 text-zinc-600">
            <li>
              <strong>Morning briefing</strong>: recurring schedule at 8am,
              execute mode. The assistant checks your calendar, email, and
              Slack, then sends you a digest.
            </li>
            <li>
              <strong>Follow-up tracking</strong>: one-shot schedule set 3
              days out, execute mode. &ldquo;If Alice hasn&apos;t replied by
              Thursday, draft a follow-up.&rdquo;
            </li>
            <li>
              <strong>Inbox monitoring</strong>: Gmail watcher with a 60s
              poll interval. &ldquo;When an important email arrives, notify me
              on Telegram.&rdquo;
            </li>
            <li>
              <strong>GitHub triage</strong>: GitHub watcher monitoring a
              repo. &ldquo;When a new issue is assigned to me, summarize it
              and add it to my task list.&rdquo;
            </li>
            <li>
              <strong>Auto-responder</strong>: playbook on the email channel.
              &ldquo;When I get a meeting request, draft a polite decline with
              my availability link.&rdquo;
            </li>
            <li>
              <strong>Simple reminders</strong>: one-shot schedule, notify
              mode. &ldquo;Remind me to call the vet at 3pm.&rdquo;
            </li>
            <li>
              <strong>Relationship check-ins</strong>: heartbeat running
              every hour during work hours. Reviews the scratchpad, checks for
              pending follow-ups, reaches out when there&apos;s something
              worth sharing.
            </li>
          </ul>
        </section>

        {/* ── How scheduling connects ──────────────────────────────── */}
        <section
          id="how-scheduling-connects-to-other-concepts"
          className="mt-12"
        >
          <SectionHeading
            id="how-scheduling-connects-to-other-concepts"
            level={2}
          >
            How scheduling connects to other concepts
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-4 pl-6 text-zinc-600">
            <li>
              <strong>Skills</strong>: scheduled tasks can use any skill the
              assistant has access to. A morning briefing schedule can use
              Gmail, Google Calendar, and Slack skills in a single run.
              Watchers rely on connected integrations (Gmail, GitHub, etc.)
              for their providers.
            </li>
            <li>
              <strong>Channels</strong>: notify-mode schedules and watchers
              deliver through the notification pipeline, which routes to your
              connected channels. Playbooks can be scoped to specific
              channels.
            </li>
            <li>
              <strong>Memory</strong>: schedule and watcher execution
              happens in background conversations that have full access to the
              assistant&apos;s memory. The assistant remembers context from
              previous runs.
            </li>
            <li>
              <strong>Tasks</strong>: schedules can create, update, or
              check tasks. A recurring schedule might review your task queue
              and flag overdue items.
            </li>
          </ul>
        </section>

        {/* ── What happens when you're away ────────────────────────── */}
        <section id="what-happens-when-youre-away" className="mt-12">
          <SectionHeading id="what-happens-when-youre-away" level={2}>
            What happens when you&apos;re away
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Scheduled tasks run as long as the assistant process is running.
            On Vellum Cloud (the default), the assistant runs 24/7, so
            schedules, watchers, and heartbeats fire reliably regardless of
            whether your desktop is on. For self-hosted installs, the Vellum
            assistant on your machine needs to be active.
          </p>
          <p className="mb-4 text-zinc-600">
            The scheduler ticks every 15 seconds, so schedules fire within
            that window of their target time.
          </p>
          <p className="mb-0 text-zinc-600">
            If the assistant was offline when a schedule was supposed to fire,
            missed one-shot schedules will fire on the next startup.
            Recurring schedules compute their next run from the current time,
            so they don&apos;t replay missed runs. They just resume on
            cadence.
          </p>
        </section>

        {/* ── Setting up a schedule ────────────────────────────────── */}
        <section id="setting-up-a-schedule" className="mt-12">
          <SectionHeading id="setting-up-a-schedule" level={2}>
            Setting up a schedule
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Just tell your assistant what you want in plain language:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>&ldquo;Remind me to call Mom at 6pm&rdquo;</li>
            <li>&ldquo;Every Monday at 9am, check my email and summarize it&rdquo;</li>
            <li>&ldquo;Watch my GitHub for new issues assigned to me&rdquo;</li>
            <li>&ldquo;When I get an email from a recruiter, draft a polite pass&rdquo;</li>
            <li>&ldquo;Set up a heartbeat to check in every hour&rdquo;</li>
          </ul>
          <p className="mb-4 text-zinc-600">
            The assistant handles the translation to cron/RRULE expressions,
            watcher configurations, or playbook rules. You can also manage
            everything programmatically: schedules, watchers, and playbooks
            all have full CRUD tools (
            <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
              schedule_create
            </code>
            ,{" "}
            <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
              watcher_create
            </code>
            ,{" "}
            <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
              playbook_create
            </code>
            , etc.) and can be listed, updated, or deleted.
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
