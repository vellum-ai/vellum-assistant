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

export function SkillsReferenceTasksContent() {
  return (
    <>
      <DocsContent title="Tasks" breadcrumb="Docs / Skills Reference / Tasks">
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            A two-layer task system with reusable templates and a prioritized work queue. Define
            recurring tasks once, then run them on demand.
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
            <li>No special permissions (tasks execute within existing tool permissions)</li>
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
                    &ldquo;Create a task template for weekly status reports&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Saves a reusable task definition
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Run my weekly report task&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Executes a saved template
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;What&apos;s in my task queue?&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Shows prioritized work items
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Add &apos;review PR #42&apos; to my queue as high priority&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Adds a work item
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Mark the deployment task as done&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Updates task status
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
            <li>Priority tiers: high, medium, low</li>
            <li>Status tracking: queued, running, awaiting_review, done</li>
            <li>Templates can specify required tools</li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Templates vs. work items.</strong> Think of templates as &ldquo;recipes&rdquo;
              and work items as &ldquo;orders.&rdquo; Templates define what to do; the queue tracks
              what needs doing now.
            </li>
            <li>
              <strong>Auto-loading tools.</strong> Tasks can require specific tools &mdash; if a
              template needs browser access, the skill will load the browser skill automatically.
            </li>
            <li>
              <strong>Great for repetitive workflows.</strong> Good for repetitive workflows you want
              to hand off to your assistant.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
