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

export function SkillsReferenceSkillManagementContent() {
  return (
    <>
      <DocsContent
        title="Skill Management"
        breadcrumb="Docs / Skills Reference / Skill Management"
      >
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Creates and deletes custom managed skills. The meta-skill that lets
            you extend your assistant with new capabilities.
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
            <li>
              Skill creation/deletion is classified as high-risk and always
              requires approval
            </li>
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
                    &ldquo;Build me a skill that checks Hacker News for trending
                    posts&rdquo;
                  </td>
                  <td className="px-3 py-2">Scaffolds a new custom skill</td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Create a skill for managing my project&apos;s
                    deployment pipeline&rdquo;
                  </td>
                  <td className="px-3 py-2">Creates a domain-specific skill</td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Delete the Hacker News skill&rdquo;
                  </td>
                  <td className="px-3 py-2">Removes a custom skill</td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Show me my custom skills&rdquo;
                  </td>
                  <td className="px-3 py-2">Lists managed skills</td>
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
            <li>
              Creates a skill folder: SKILL.md (instructions) plus optional
              companion files, such as references/*.md for failure modes and
              cached values, and scripts/* for reusable code the skill runs
              (invoked with python3 or bun)
            </li>
            <li>
              Companion scripts are plain files the assistant runs from the
              terminal; skills built this way cannot register executable skill
              tools (TOOLS.json ships only with built-in and
              community-installed skills)
            </li>
            <li>Skills are saved to ~/.vellum/workspace/skills/</li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Extend your assistant.</strong> Custom skills are how you
              add capabilities beyond the built-in set.
            </li>
            <li>
              <strong>Fully automated.</strong> The assistant writes the code,
              tests it, and packages it &mdash; you just describe what you want.
            </li>
            <li>
              <strong>High-risk classification.</strong> Skill source file
              modifications always require approval to prevent privilege
              escalation.
            </li>
            <li>
              <strong>Review before approving.</strong> Check the generated code
              before granting approval. You can also edit skill files directly
              if you prefer.
            </li>
            <li>
              <strong>Scripts come from proven runs.</strong> When the assistant
              stores a scripts/ file in a skill, it saves the exact code it
              already ran successfully, so reusing the skill later runs the
              script instead of rewriting the code from scratch.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
