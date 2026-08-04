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

export function SkillsReferenceChatGPTImportContent() {
  return (
    <>
      <DocsContent title="ChatGPT Import" breadcrumb="Docs / Skills Reference / ChatGPT Import">
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Imports your conversation history from ChatGPT into Vellum so your assistant can learn
            from your past interactions.
          </p>
        </section>

        <section id="setup-required" className="mt-12">
          <SectionHeading id="setup-required" level={2}>
            Setup required
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Export your data from ChatGPT (Settings &gt; Data controls &gt; Export data).
            You&apos;ll receive a ZIP file.
          </p>
        </section>

        <section id="permissions" className="mt-12">
          <SectionHeading id="permissions" level={2}>
            Permissions
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>File access to read the exported ZIP archive</li>
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
                    &ldquo;Import my ChatGPT history&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Starts the import process
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;I have a ChatGPT export ZIP file, can you import it?&rdquo;
                  </td>
                  <td className="px-3 py-2">Processes the export</td>
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
            <li>Imports user and assistant messages with original timestamps preserved</li>
            <li>Deduplicates on re-import (safe to run multiple times)</li>
            <li>Imported conversations are auto-indexed for memory search</li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Timestamps preserved.</strong> Your assistant understands the chronological
              context of imported conversations.
            </li>
            <li>
              <strong>Safe to re-import.</strong> Deduplication means you can re-import without
              creating duplicates.
            </li>
            <li>
              <strong>Memory indexing.</strong> After import, facts and preferences from your ChatGPT
              history become searchable via the memory system.
            </li>
            <li>
              <strong>Selective import.</strong> Only user and assistant messages are imported
              &mdash; system prompts and metadata are skipped.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
