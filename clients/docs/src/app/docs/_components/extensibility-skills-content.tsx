"use client";

import Link from "next/link";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "what-a-skill-is", label: "What a skill is", level: 2 },
  { id: "frontmatter-reference", label: "Frontmatter reference", level: 2 },
  { id: "resolution-order", label: "Resolution order", level: 2 },
  { id: "anatomy-of-a-skill", label: "Anatomy of a skill", level: 2 },
  {
    id: "when-to-write-a-skill",
    label: "When should my assistant write a Skill?",
    level: 2,
  },
];

const linkClass =
  "font-semibold text-emerald-700 underline hover:text-emerald-800";

const OVERVIEW_PAGE_URL = "/docs/extensibility";

type SkillField = {
  name: string;
  type: string;
  required: string;
  desc: string;
};

const FRONTMATTER_FIELDS: SkillField[] = [
  {
    name: "name",
    type: "string",
    required: "Yes",
    desc: "Skill display name used in skill lists and matching. The canonical identifier is the directory basename (the folder name under skills/), not this field. Keep them aligned to avoid confusion, but note that the runtime uses the directory name for deduplication and collision resolution.",
  },
  {
    name: "description",
    type: "string",
    required: "Yes",
    desc: "What the skill does and when to use it. The Assistant matches against this to decide whether to load the skill, so write it for the model, not for a human reader.",
  },
  {
    name: "metadata.emoji",
    type: "string",
    required: "No",
    desc: "Glyph shown next to the skill in clients that render a skill list.",
  },
  {
    name: "metadata.vellum.display-name",
    type: "string",
    required: "No",
    desc: "Human-friendly label for the skill. Falls back to name when omitted.",
  },
  {
    name: "metadata.vellum.activation-hints",
    type: "string[]",
    required: "No",
    desc: "Plain-language situations where the skill should activate. These sharpen the match beyond the description.",
  },
  {
    name: "metadata.vellum.avoid-when",
    type: "string[]",
    required: "No",
    desc: "Situations where the skill should not activate, used to keep it from firing on adjacent-but-wrong requests.",
  },
  {
    name: "metadata.vellum.category",
    type: "string",
    required: "No",
    desc: 'Grouping used when the skill is listed in a client. Defaults to "system".',
  },
];

function FieldTable({ fields }: { fields: SkillField[] }) {
  return (
    <div className="mb-4 overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-left dark:border-zinc-700">
            <th className="py-2 pr-4 font-semibold text-zinc-900 dark:text-zinc-100">
              Field
            </th>
            <th className="py-2 pr-4 font-semibold text-zinc-900 dark:text-zinc-100">
              Type
            </th>
            <th className="py-2 pr-4 font-semibold text-zinc-900 dark:text-zinc-100">
              Required
            </th>
            <th className="py-2 font-semibold text-zinc-900 dark:text-zinc-100">
              Description
            </th>
          </tr>
        </thead>
        <tbody className="text-zinc-600 dark:text-zinc-400">
          {fields.map((field) => (
            <tr
              key={field.name}
              className="border-b border-zinc-100 align-top dark:border-zinc-800"
            >
              <td className="py-2 pr-4">
                <code>{field.name}</code>
              </td>
              <td className="py-2 pr-4">
                <code className="text-zinc-500 dark:text-zinc-400">
                  {field.type}
                </code>
              </td>
              <td className="py-2 pr-4">{field.required}</td>
              <td className="py-2">{field.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ExtensibilitySkillsContent() {
  return (
    <>
      <DocsContent
        title="Skills"
        breadcrumb="Docs / Extensibility / Skills"
        subtitle="Bundle instructions, assets, and scripts the Assistant pulls in on demand. A skill teaches the Assistant a repeatable workflow it loads only when the situation calls for it."
      >
        <p className="mb-8 text-zinc-600 dark:text-zinc-400">
          A skill is a directory with a <code>SKILL.md</code> at its root. The
          file is YAML frontmatter followed by a markdown body: the frontmatter
          tells the Assistant what the skill is for, and the body is the
          instructions it follows once the skill is active. A plugin ships
          skills under <code>skills/&lt;name&gt;/</code>, and the skill catalog
          loader discovers them on disk.
        </p>

        <section id="what-a-skill-is">
          <SectionHeading id="what-a-skill-is" level={2}>
            What a skill is
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            A skill is a bundle of instructions and supporting files that the
            Assistant loads into context when the conversation matches what the
            skill is for. Nothing runs on its own: the skill gives the Assistant
            a procedure to follow, plus any scripts or assets it ships
            alongside.
          </p>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            The Assistant decides when to load a skill from its{" "}
            <code>description</code> and activation hints, so write those fields
            for the model: say what the skill is for and the situations it
            should fire in.
          </p>
        </section>

        <section id="frontmatter-reference" className="mt-12">
          <SectionHeading id="frontmatter-reference" level={2}>
            Frontmatter reference
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            These are the fields the <code>SKILL.md</code> frontmatter can set.
            Only <code>name</code> and <code>description</code> are required;
            everything under <code>metadata</code> is optional and refines how
            the skill is presented and matched.
          </p>
          <FieldTable fields={FRONTMATTER_FIELDS} />
        </section>

        <section id="resolution-order" className="mt-12">
          <SectionHeading id="resolution-order" level={2}>
            Resolution order
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Skills are discovered at boot and loaded into the catalog in a fixed
            order. The model then pulls skills into context on demand: it
            matches the conversation against each skill&apos;s{" "}
            <code>description</code> and activation hints, then loads the ones
            that fit. Multiple skills can be active at the same time.
          </p>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Discovery is filesystem-driven and happens before the first turn:
          </p>
          <ol className="mb-4 list-decimal space-y-2 pl-6 text-zinc-600 dark:text-zinc-400">
            <li>
              <strong className="text-zinc-900 dark:text-zinc-100">
                Bundled skills
              </strong>
              . Shipped with the Assistant, discovered from the built-in skills
              directory.
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-zinc-100">
                Workspace skills
              </strong>
              . Discovered from <code>/workspace/skills/</code>, letting you
              drop a skill directory without packaging it as a plugin.
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-zinc-100">
                Plugin skills
              </strong>
              . Discovered from every plugin&apos;s <code>skills/</code>{" "}
              subdirectory at boot.
            </li>
          </ol>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            When two skills with the same name are discovered, the first one
            found wins and the duplicate is logged and skipped. The load order
            above determines which skill wins a name collision; once loaded,
            there is no execution priority between skills. They are instruction
            bundles, not runnable hooks, and the model decides which to follow
            based on the frontmatter, not on timing.
          </p>
        </section>

        <section id="anatomy-of-a-skill" className="mt-12">
          <SectionHeading id="anatomy-of-a-skill" level={2}>
            Anatomy of a skill
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            One skill per directory. The <code>SKILL.md</code> is required;
            assets and helper scripts are optional and live alongside it:
          </p>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`plugins/my-plugin/
└── skills/
    └── standup-notes/
        ├── SKILL.md        # Frontmatter + instructions (required)
        ├── references/     # Optional docs the instructions cite
        └── scripts/        # Optional helper scripts the skill runs
            └── post_summary.ts`}</code>
          </pre>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            The <code>SKILL.md</code> itself is frontmatter plus the procedure
            the Assistant follows once the skill is active:
          </p>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`---
name: standup-notes
description: >-
  Draft a daily standup update from recent activity. Use when the user
  asks for their standup, daily update, or what they did yesterday.
metadata:
  vellum:
    display-name: "Standup Notes"
    activation-hints:
      - "User asks for their standup or daily update"
    avoid-when:
      - "User wants a full weekly report, not a daily standup"
---

Draft a concise standup update with three sections: Yesterday, Today,
and Blockers.

## Steps

1. Summarize what was completed since the last standup.
2. List what the user plans to work on today.
3. Call out any blockers, or write "None" when there are none.

Keep each section to a few short bullet points.`}</code>
          </pre>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            The <code>scripts/</code> and <code>references/</code> directories
            are optional companions to <code>SKILL.md</code>. The body invokes
            them by relative path:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600 dark:text-zinc-400">
            <li>
              <strong className="text-zinc-900 dark:text-zinc-100">
                Scripts
              </strong>
              . Reference a script by its path relative to the skill directory.
              The assistant runs it via the <code>bash</code> tool when the
              instructions call for it. For example, a body that says &quot;Run{" "}
              <code>scripts/post_summary.ts</code> to submit the summary&quot; tells
              the assistant to execute{" "}
              <code>bun run scripts/post_summary.ts</code> from the skill
              directory.
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-zinc-100">
                References
              </strong>
              . Cite a reference file by relative path when the body needs to
              defer detail. For example, &quot;See{" "}
              <code>references/api-fields.md</code> for the full field contract&quot;
              tells the assistant to read that file when it needs the details,
              rather than inlining them in the body. This keeps the body short
              and loads the detail only when relevant.
            </li>
          </ul>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            See the{" "}
            <Link href={OVERVIEW_PAGE_URL} className={linkClass}>
              Extensibility overview
            </Link>{" "}
            for how skills sit alongside the other surfaces a plugin can bundle.
          </p>
        </section>

        <section id="when-to-write-a-skill" className="mt-12">
          <SectionHeading id="when-to-write-a-skill" level={2}>
            When should my assistant write a Skill?
          </SectionHeading>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            Reach for a skill when the capability is a repeatable procedure the
            model should follow in natural language, not code that has to run
            deterministically. A skill is the right home for &ldquo;here is how
            we do X&rdquo;: the steps, the house style, the reference material,
            and any helper scripts those steps call. It is dynamically loaded
            only when the conversation matches, so it costs nothing in the
            model&apos;s context until the request calls for it.
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
