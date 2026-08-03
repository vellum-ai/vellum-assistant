"use client";

import Link from "next/link";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "what-are-skills", label: "What are skills?", level: 2 },
  {
    id: "what-self-improving-means",
    label: "What self-improving means",
    level: 2,
  },
  {
    id: "how-a-skill-is-learned",
    label: "How a skill is learned",
    level: 2,
  },
  { id: "what-qualifies", label: "What qualifies", level: 2 },
  { id: "create-vs-refine", label: "Create vs. refine", level: 2 },
  { id: "when-you-see-it", label: "When you see it", level: 2 },
  {
    id: "review-edit-or-remove",
    label: "Review, edit, or remove",
    level: 2,
  },
  { id: "boundaries", label: "Boundaries", level: 2 },
];

const linkClass =
  "font-medium text-emerald-700 underline decoration-emerald-700/30 underline-offset-2 hover:text-emerald-800 dark:text-mint-300 dark:hover:text-mint-200";

export function SelfImprovingSkillsContent() {
  return (
    <>
      <DocsContent
        title="Self-improving Skills"
        breadcrumb="Docs / Key Concepts / Self-improving Skills"
      >
        <p className="mb-4 text-zinc-600 dark:text-zinc-400">
          Your assistant can preserve a useful procedure after it has actually
          carried it out, then reuse that procedure when a similar task comes
          up. The result is a managed skill that remains visible and under your
          control.
        </p>
        <p className="mb-8 text-zinc-600 dark:text-zinc-400">
          This capability connects what your assistant remembers with what it
          knows how to do. For the broader concepts, see{" "}
          <Link
            href="/docs/key-concepts/memory-and-context"
            className={linkClass}
          >
            Memory &amp; Context
          </Link>{" "}
          and{" "}
          <Link
            href="/docs/key-concepts/skills-and-tools"
            className={linkClass}
          >
            Tools &amp; Skills
          </Link>
          .
        </p>

        <section id="what-are-skills">
          <SectionHeading id="what-are-skills" level={2}>
            What are skills?
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Skills are reusable sets of instructions, tools, and supporting files
            that teach your assistant how to handle a particular kind of task. A
            skill can describe when to use it, the steps to follow, checks to make
            along the way, and what a finished result looks like.
          </p>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            Vellum includes skills for common tasks, and you can add or create
            more. When a request matches a skill, your assistant loads its
            instructions and follows the procedure instead of starting from
            scratch.
          </p>
        </section>

        <section id="what-self-improving-means" className="mt-12">
          <SectionHeading id="what-self-improving-means" level={2}>
            What self-improving means
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Self-improving does not mean that Vellum retrains the model or
            changes its underlying intelligence. After eligible work is
            complete, memory can preserve procedures your assistant actually used
            as reusable instructions.
          </p>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            The distinction is practical: facts, preferences, decisions, and
            other things worth recalling remain memories, while repeatable
            procedures can become skills. This lets your assistant retain both
            what happened and how to perform useful work again without confusing
            the two.
          </p>
        </section>

        <section id="how-a-skill-is-learned" className="mt-12">
          <SectionHeading id="how-a-skill-is-learned" level={2}>
            How a skill is learned
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Learning starts with completed work. Memory reviews what the
            assistant actually did, including the sequence it followed, the
            tools it used, and the outcome it reached. It does not turn an
            untested suggestion or a procedure the assistant merely described
            into a skill.
          </p>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            When the work contains a reusable procedure, Vellum can express that
            procedure as a managed skill with instructions and supporting files.
            Future conversations can then load the skill when a request calls
            for the same kind of work.
          </p>
        </section>

        <section id="what-qualifies" className="mt-12">
          <SectionHeading id="what-qualifies" level={2}>
            What qualifies
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            A procedure qualifies when it represents useful, repeatable work
            that the assistant actually carried out and that is not already
            covered by an existing skill. A one-time fact, a preference, or a
            project update remains memory because recalling it is more useful
            than turning it into instructions.
          </p>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            For example, learning that a project uses a particular hosting
            provider is a fact. Learning the concrete steps the assistant used
            to deploy that project can be a procedure. Only the second belongs in
            a skill.
          </p>
        </section>

        <section id="create-vs-refine" className="mt-12">
          <SectionHeading id="create-vs-refine" level={2}>
            Create vs. refine
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Before creating anything, Vellum checks the skills already available
            to your assistant. It creates a new skill only when the procedure is
            distinct. If an assistant-authored skill already covers the work,
            Vellum may refine that skill with what the assistant verified in the
            new conversation.
          </p>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            Vellum does not overwrite skills you authored or other skills you
            installed. Those remain unchanged, so automatic learning cannot
            replace instructions that came from you or another source.
          </p>
        </section>

        <section id="when-you-see-it" className="mt-12">
          <SectionHeading id="when-you-see-it" level={2}>
            When you see it
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            A learned skill is created after the work is complete, then announced
            for review. You do not need to approve it before it is created.
          </p>
          <p className="mb-0 text-zinc-600">
            When Vellum learns a genuinely new skill, the source conversation
            shows an &ldquo;I just learned how to do...&rdquo; card. Opening the
            card takes you to the learned skill so you can inspect what was
            preserved. Routine memory updates and refinements that do not create
            a distinct new skill do not produce this card.
          </p>
        </section>

        <section id="review-edit-or-remove" className="mt-12">
          <SectionHeading id="review-edit-or-remove" level={2}>
            Review, edit, or remove
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Learned skills are managed skills, not hidden changes to the model.
            From Skills, you can view a skill’s files, edit its text files when
            you want to adjust the procedure, and inspect its source conversation
            when that lineage was recorded.
          </p>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            You can also remove a learned skill from Skills. Removing it stops
            the procedure from being available as that managed skill while
            leaving the original conversation intact.
          </p>
        </section>

        <section id="boundaries" className="mt-12">
          <SectionHeading id="boundaries" level={2}>
            Boundaries
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Learning a skill does not make it active in every conversation. Like
            other skills, it loads only when the current request is relevant,
            which keeps unrelated instructions out of the way.
          </p>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            A learned skill also does not gain broader access than the tools it
            uses. Those tools keep their normal permission boundaries, and the
            assistant must still operate within the access available in the
            current context. To understand how skills package instructions and
            tools, return to{" "}
            <Link
              href="/docs/key-concepts/skills-and-tools"
              className={linkClass}
            >
              Tools &amp; Skills
            </Link>
            . To learn how facts and prior conversations are recalled, return to{" "}
            <Link
              href="/docs/key-concepts/memory-and-context"
              className={linkClass}
            >
              Memory &amp; Context
            </Link>
            .
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
