"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "what-it-does", label: "What it does", level: 2 },
  { id: "setup-required", label: "Setup required", level: 2 },
  { id: "permissions", label: "Permissions", level: 2 },
  { id: "common-prompts", label: "Common prompts", level: 2 },
  { id: "configuration", label: "Configuration", level: 2 },
  { id: "tips-gotchas", label: "Tips & gotchas", level: 2 },
];

export function SkillsReferenceScheduleContent() {
  return (
    <>
      <DocsContent title="Schedule" breadcrumb="Docs / Skills Reference / Schedule">
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Sets up recurring and one-shot scheduled actions using cron syntax, RRULE patterns, or
            simple timestamps. Your assistant can do things on a schedule without you asking.
          </p>
        </section>

        <section id="setup-required" className="mt-12">
          <SectionHeading id="setup-required" level={2}>
            Setup required
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            None. Works immediately.
          </p>
        </section>

        <section id="permissions" className="mt-12">
          <SectionHeading id="permissions" level={2}>
            Permissions
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>No special permissions needed</li>
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
                  <td className="px-3 py-2">
                    &ldquo;Remind me to check my email every morning at 9am&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Creates a recurring schedule
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Set a reminder for March 15th at 2pm&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    One-time scheduled notification
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Every Friday at 5pm, summarize my week&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Recurring task with execution
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Show me my active schedules&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Lists all scheduled items
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Cancel the morning email reminder&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Deletes a schedule
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section id="configuration" className="mt-12">
          <SectionHeading id="configuration" level={2}>
            Configuration
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>Supports cron syntax for recurring schedules</li>
            <li>RRULE (RFC 5545) for complex recurrence patterns</li>
            <li>ISO 8601 timestamps for one-time events</li>
            <li>
              Four modes: &ldquo;execute&rdquo; (run a task), &ldquo;notify&rdquo; (send a
              notification), &ldquo;script&rdquo; (run a shell command), or
              &ldquo;workflow&rdquo; (run a saved workflow)
            </li>
            <li>Timezone-aware</li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Persistent across conversations.</strong> Schedules persist across
              conversations &mdash; set it once and it runs until you cancel it.
            </li>
            <li>
              <strong>Simple reminders.</strong> For simple reminders, just say
              &ldquo;remind me.&rdquo;
            </li>
            <li>
              <strong>Complex patterns.</strong> For complex patterns (&ldquo;every other
              Tuesday&rdquo;), the RRULE support handles it.
            </li>
            <li>
              <strong>Same permission rules.</strong> Scheduled actions run with the same permission
              rules as interactive actions &mdash; your assistant won&apos;t do anything it
              couldn&apos;t do in a normal conversation.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
