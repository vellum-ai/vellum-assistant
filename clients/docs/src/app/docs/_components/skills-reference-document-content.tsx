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

export function SkillsReferenceDocumentContent() {
  return (
    <>
      <DocsContent title="Document" breadcrumb="Docs / Skills Reference / Document">
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Creates and edits long-form text &mdash; blog posts, articles, essays, reports, and
            guides &mdash; in a dedicated rich-text editor with Markdown support.
          </p>
        </section>

        <section id="setup-required" className="mt-12">
          <SectionHeading id="setup-required" level={2}>
            Setup required
          </SectionHeading>
          <p className="mb-0 text-zinc-600">None. Works immediately.</p>
        </section>

        <section id="permissions" className="mt-12">
          <SectionHeading id="permissions" level={2}>
            Permissions
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>No special permissions needed (operates within the workspace)</li>
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
                    &ldquo;Write a blog post about AI productivity tools&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Opens editor with drafted content
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Help me write a project proposal&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Creates a structured document
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Edit my draft and make it more concise&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Revises existing document
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Turn these notes into a proper report&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Transforms raw notes into formatted output
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
            <li>Editor supports Markdown</li>
            <li>Content streams in real-time as the assistant writes</li>
            <li>Documents can be updated iteratively</li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Dedicated workspace mode.</strong> The document editor is a separate workspace
              mode &mdash; the chat docks to the side while the document takes center stage.
            </li>
            <li>
              <strong>Long-form vs. chat.</strong> For quick text, just ask in chat; for polished
              long-form writing, use the Document skill.
            </li>
            <li>
              <strong>Saved to workspace.</strong> Content is saved to your workspace.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
