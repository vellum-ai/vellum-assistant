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

export function SkillsReferenceWatcherContent() {
  return (
    <>
      <DocsContent title="Watcher" breadcrumb="Docs / Skills Reference / Watcher">
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Polls external services for changes and notifies you when something happens. Monitors
            Gmail, Google Calendar, GitHub, Linear, and other services on a schedule.
          </p>
        </section>

        <section id="setup-required" className="mt-12">
          <SectionHeading id="setup-required" level={2}>
            Setup required
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Requires connected services (OAuth for Gmail, Calendar, etc.).
          </p>
        </section>

        <section id="permissions" className="mt-12">
          <SectionHeading id="permissions" level={2}>
            Permissions
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>Requires OAuth connections to the services being watched</li>
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
                    &ldquo;Watch my Gmail for emails from investors&rdquo;
                  </td>
                  <td className="px-3 py-2">Creates a Gmail watcher</td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Monitor this GitHub repo for new PRs&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Sets up GitHub monitoring
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Alert me when my next calendar event changes&rdquo;
                  </td>
                  <td className="px-3 py-2">Calendar watcher</td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Show me my active watchers&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Lists all running watchers
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Give me a digest of everything my watchers found today&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Summarizes all watcher activity
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Stop watching my inbox&rdquo;
                  </td>
                  <td className="px-3 py-2">Disables a watcher</td>
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
            <li>Configurable poll intervals</li>
            <li>Each watcher runs independently</li>
            <li>Digest summaries aggregate findings</li>
            <li>Watchers can be enabled/disabled without deletion</li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Not Screen Watch.</strong> Watchers monitor external services (APIs), not your
              screen.
            </li>
            <li>
              <strong>Schedule-based.</strong> Watchers run on a schedule, not continuously.
            </li>
            <li>
              <strong>Stay on top of things.</strong> Great for new PRs, important emails, calendar
              changes, and Linear ticket updates without constantly checking.
            </li>
            <li>
              <strong>Digest command.</strong> Gives you a summary of everything watchers found.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
