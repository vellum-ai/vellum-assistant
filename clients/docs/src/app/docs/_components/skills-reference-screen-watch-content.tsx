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

export function SkillsReferenceScreenWatchContent() {
  return (
    <>
      <DocsContent title="Screen Watch" breadcrumb="Docs / Skills Reference / Screen Watch">
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Observes your screen at regular intervals using OCR, letting your assistant provide
            context-aware commentary on what you&apos;re working on.
          </p>
        </section>

        <section id="setup-required" className="mt-12">
          <SectionHeading id="setup-required" level={2}>
            Setup required
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            None. Requires Screen Recording permission.
          </p>
        </section>

        <section id="permissions" className="mt-12">
          <SectionHeading id="permissions" level={2}>
            Permissions
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>Screen Recording (to capture screen content)</li>
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
                    &ldquo;Watch what I&apos;m doing for the next 5 minutes&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Starts periodic screen observation
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Keep an eye on my screen and help me with this spreadsheet&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Monitors with focus area
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Watch my screen and let me know if I make any mistakes&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Active monitoring with feedback
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
            <li>Configurable interval (5&ndash;30 seconds between captures)</li>
            <li>Duration (1&ndash;15 minutes)</li>
            <li>Optional focus area for targeted observation</li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Not always-on.</strong> This is not always-on background monitoring &mdash;
              it&apos;s explicitly triggered and time-bounded.
            </li>
            <li>
              <strong>OCR-based.</strong> OCR captures text content, not pixel-perfect screenshots.
            </li>
            <li>
              <strong>Best for second-pair-of-eyes tasks.</strong> Reviewing documents, filling out
              forms, or learning a new tool.
            </li>
            <li>
              <strong>Different from Computer Use.</strong> Screen Watch observes, Computer Use
              acts.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
