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

export function SkillsReferenceNotificationsContent() {
  return (
    <>
      <DocsContent title="Notifications" breadcrumb="Docs / Skills Reference / Notifications">
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Sends notifications through a unified routing system across your connected channels. One
            notification, delivered to the right place.
          </p>
        </section>

        <section id="setup-required" className="mt-12">
          <SectionHeading id="setup-required" level={2}>
            Setup required
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            None. Uses whatever channels you have connected.
          </p>
        </section>

        <section id="permissions" className="mt-12">
          <SectionHeading id="permissions" level={2}>
            Permissions
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>Requires at least one connected channel for delivery</li>
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
                    &ldquo;Notify me when the deployment finishes&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Sets up a triggered notification
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Send me a notification on Telegram about this&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Routes to a specific channel
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Alert me if anything urgent comes up&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Configures priority-based notification
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
            <li>Urgency levels: low, medium, high</li>
            <li>Deduplication prevents repeated notifications</li>
            <li>Channel routing hints let you prefer specific delivery channels</li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Outbound counterpart to channels.</strong> Notifications use your connected
              channels (Telegram, Slack, desktop) to reach you.
            </li>
            <li>
              <strong>Smart routing.</strong> The system picks the best channel based on your
              preferences and what&apos;s available.
            </li>
            <li>
              <strong>Automatic deduplication.</strong> Notifications deduplicate automatically so
              you won&apos;t get spammed.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
