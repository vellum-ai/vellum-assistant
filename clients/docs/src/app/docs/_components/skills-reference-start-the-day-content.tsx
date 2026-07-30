"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "what-it-does", label: "What it does", level: 2 },
  { id: "setup-required", label: "Setup required", level: 2 },
  { id: "permissions", label: "Permissions", level: 2 },
  { id: "common-prompts", label: "Common prompts", level: 2 },
  { id: "whats-in-a-briefing", label: "What's in a briefing", level: 2 },
  { id: "configuration", label: "Configuration", level: 2 },
  { id: "tips-gotchas", label: "Tips & gotchas", level: 2 },
];

export function SkillsReferenceStartTheDayContent() {
  return (
    <>
      <DocsContent title="Start the Day" breadcrumb="Docs / Skills Reference / Start the Day">
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Gives you a personalized daily briefing with weather, calendar, news, tasks, and
            actionable insights. Your morning rundown without opening six apps.
          </p>
        </section>

        <section id="setup-required" className="mt-12">
          <SectionHeading id="setup-required" level={2}>
            Setup required
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Works immediately for basic briefings (weather, news). For calendar integration,
            connect Google Calendar first. For email, set up AgentMail first.
          </p>
        </section>

        <section id="permissions" className="mt-12">
          <SectionHeading id="permissions" level={2}>
            Permissions
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>No macOS permissions needed for basic briefing</li>
            <li>Calendar access needed for schedule summary (if connected)</li>
            <li>Email access needed for inbox summary (if connected)</li>
          </ul>
        </section>

        <section id="common-prompts" className="mt-12">
          <SectionHeading id="common-prompts" level={2}>
            Common prompts
          </SectionHeading>
          <div className="mb-0 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-zinc-50">
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    You say...
                  </th>
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    What happens
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50">
                <tr>
                  <td className="px-3 py-2">&ldquo;Start my day&rdquo;</td>
                  <td className="px-3 py-2">
                    Full morning briefing: weather, calendar, tasks, news
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Give me my morning rundown&rdquo;
                  </td>
                  <td className="px-3 py-2">Same as above</td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;What should I know today?&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Highlights the most important items
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">&ldquo;Briefing&rdquo;</td>
                  <td className="px-3 py-2">
                    Quick version of the daily summary
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section id="whats-in-a-briefing" className="mt-12">
          <SectionHeading id="whats-in-a-briefing" level={2}>
            What&apos;s in a briefing
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            A typical &ldquo;start my day&rdquo; response includes:
          </p>
          <ol className="mb-0 list-decimal space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Weather</strong>: Current conditions and today&apos;s forecast for your location
            </li>
            <li>
              <strong>Calendar</strong>: Today&apos;s events, upcoming meetings, any conflicts
            </li>
            <li>
              <strong>Tasks</strong>: Open items in your task queue, overdue tasks, high-priority items
            </li>
            <li>
              <strong>Email</strong>: Unread count, any important messages (if email is set up)
            </li>
            <li>
              <strong>News</strong>: Top headlines relevant to your interests
            </li>
            <li>
              <strong>Insights</strong>: Anything your assistant thinks you should know based on context
            </li>
          </ol>
        </section>

        <section id="configuration" className="mt-12">
          <SectionHeading id="configuration" level={2}>
            Configuration
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>Briefing content adapts based on what services you have connected</li>
            <li>
              No calendar connected? No calendar section. No email? No email section. It adjusts.
            </li>
            <li>Your location is used for weather (set in USER.md)</li>
            <li>
Briefings get more personalized over time: your assistant learns your
              interests, schedule patterns, and recurring tasks to weight news and priorities
              accordingly
            </li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>It gets better over time.</strong> The more your assistant knows about you
              (projects, priorities, interests), the more personalized and useful the briefing becomes.
            </li>
            <li>
              <strong>Automate it.</strong> Set up a schedule: &ldquo;Every weekday at 8am, start my day.&rdquo;
              Then it happens automatically.
            </li>
            <li>
              <strong>Customize verbosity:</strong> &ldquo;Give me the short version&rdquo; for bullet points,
              or &ldquo;give me everything&rdquo; for the deep dive.
            </li>
            <li>
              <strong>Weekend mode:</strong> Briefings on weekends can be different. &ldquo;On weekends,
              skip the work calendar and just give me weather and news.&rdquo;
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
