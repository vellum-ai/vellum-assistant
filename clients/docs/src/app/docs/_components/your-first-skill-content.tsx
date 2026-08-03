"use client";

import Link from "next/link";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "why-skills-matter", label: "Why skills matter", level: 2 },
  { id: "whats-a-skill", label: "What's a skill?", level: 2 },
  { id: "built-in-skills", label: "Built-in skills", level: 2 },
  { id: "installing-community-skills", label: "Installing community skills", level: 2 },
  { id: "building-a-custom-skill", label: "Building a custom skill", level: 2 },
  { id: "step-1-pick-one-task", label: "Step 1: Pick one task", level: 3 },
  { id: "step-2-draft-the-recipe", label: "Step 2: Draft the recipe", level: 3 },
  { id: "step-3-test-and-iterate", label: "Step 3: Test and iterate", level: 3 },
  { id: "step-4-refine-until-reliable", label: "Step 4: Refine until reliable", level: 3 },
];

export function YourFirstSkillContent() {
  return (
    <>
      <DocsContent title="Your First Skill" breadcrumb="Docs / Getting Started / Your First Skill">
        <p className="mb-4 text-zinc-600">
          Skills are how your agent learns to do new things. Not prompts you type once and forget,
          but durable capabilities you teach your agent once, and it keeps doing them for you.
        </p>
        <p className="mb-8 text-zinc-600">
          The model matters, but it was never the thing holding you back. A raw agent does not know
          your work, your voice, your tools, or the way you like things done. Skills close that gap.
          Your agent comes with 40+ built-in skills, and you can teach it new ones just by talking
          to it.
        </p>

        <section id="why-skills-matter">
          <SectionHeading id="why-skills-matter" level={2}>
            Why skills matter
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Most people use AI as a chat. Ask something, get an answer, move on. The next day they
            ask the same thing and the agent starts from zero. That is not a problem with the model.
            It is a problem with the architecture.
          </p>
          <p className="mb-6 text-zinc-600">
            A skill is the opposite of a one-off chat. It is a workflow you teach your agent once,
            and it runs the same way every time, with your format, your voice, your tools, and your
            edge cases locked in.
          </p>
        </section>

        <section id="whats-a-skill">
          <SectionHeading id="whats-a-skill" level={2}>
            What&apos;s a skill?
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            A skill gives your agent a new ability. It is a folder with a recipe, reference files,
            and tool declarations that teach your agent how to do one specific job well.
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>The <strong>Weather</strong> skill checks forecasts for any location</li>
            <li>The <strong>Gmail</strong> skill reads, writes, and manages your email</li>
            <li>The <strong>DoorDash</strong> skill orders food, delivered to your door</li>
            <li>The <strong>Schedule</strong> skill sets up recurring tasks and reminders</li>
          </ul>
          <p className="mb-6 text-zinc-600">
            You do not have to think about skills at all. Your agent picks the right one when you
            ask it to do something. But knowing they exist, and that you can build your own, changes
            what is possible.
          </p>
        </section>

        <section id="built-in-skills" className="mt-12">
          <SectionHeading id="built-in-skills" level={2}>
            Built-in skills
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Your agent ships with 40+ skills across communication, productivity, automation,
            development, and media. Most work instantly. A few, like Gmail, Slack, and Phone Calls,
            need a one-time setup, and your agent walks you through it on first use.
          </p>
          <p className="mb-6 text-zinc-600">
            For the full list, see the{" "}
            <Link href="https://www.vellum.ai/skills" className="font-semibold text-emerald-700 underline hover:text-emerald-800">
              Skills Reference
            </Link>.
          </p>
        </section>

        <section id="installing-community-skills" className="mt-12">
          <SectionHeading id="installing-community-skills" level={2}>
            Installing community skills
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Want something that is not built in? There is a growing library of community skills at{" "}
            <a href="https://skills.sh" className="font-semibold text-emerald-700 underline hover:text-emerald-800">skills.sh</a>.
            Just ask:
          </p>
          <blockquote className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-zinc-700">
            &quot;Search for a Notion skill.&quot;
          </blockquote>
          <p className="mb-6 text-zinc-600">
            Your agent finds it, shows you what it does, and installs it with your permission. From
            there it works just like a built-in skill.
          </p>
        </section>

        <section id="building-a-custom-skill" className="mt-12">
          <SectionHeading id="building-a-custom-skill" level={2}>
            Building a custom skill
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            This is where it gets powerful. You can create new skills by describing what you want in
            the chat. Do not treat it as a feature request. Treat it as teaching. You are writing a
            recipe your agent will follow every time.
          </p>

          <h3 id="step-1-pick-one-task" className="mb-3 mt-8 text-lg font-semibold text-zinc-800">
            Step 1: Pick one task
          </h3>
          <p className="mb-4 text-zinc-600">
            Pick something you do every week and find tedious. Specific, not generic. Not &quot;write
            blog posts.&quot; Something like:
          </p>
          <blockquote className="mb-3 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-zinc-700">
            &quot;Check our competitor pricing every Monday and give me a table with price, change,
            and verdict.&quot;
          </blockquote>
          <blockquote className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-zinc-700">
            &quot;Read our overnight support tickets, group them by category, and post a summary to
            Slack at 9 AM.&quot;
          </blockquote>
          <p className="mb-6 text-zinc-600">
            The narrower the better. A skill that does one thing well beats a skill that tries to do
            everything.
          </p>

          <h3 id="step-2-draft-the-recipe" className="mb-3 mt-8 text-lg font-semibold text-zinc-800">
            Step 2: Draft the recipe
          </h3>
          <p className="mb-4 text-zinc-600">
            Your agent drafts the skill from what you described. It writes the instructions,
            bundles any reference notes and scripts the workflow needs, and sets the format. It
            does this with its built-in <strong>Skill Management</strong>{" "}
            skill, the skill that builds skills. You do not invoke it directly. Just describe what
            you want and your agent reaches for it automatically.
          </p>
          <p className="mb-4 text-zinc-600">
            A good skill has four ingredients:
          </p>
          <ol className="mb-4 list-decimal space-y-2 pl-6 text-zinc-600">
            <li><strong>Clear purpose.</strong> One task, one output.</li>
            <li><strong>Workflow steps.</strong> The exact sequence your agent follows every time.</li>
            <li><strong>Tool access.</strong> What it needs to read, search, or call.</li>
            <li><strong>Output format.</strong> What a perfect result looks like. Show an example.</li>
          </ol>
          <p className="mb-6 text-zinc-600">
            Your agent asks follow-up questions if it needs more detail. Be specific about format,
            voice, and edge cases. The recipe is only as good as the instructions.
          </p>

          <h3 id="step-3-test-and-iterate" className="mb-3 mt-8 text-lg font-semibold text-zinc-800">
            Step 3: Test and iterate
          </h3>
          <p className="mb-4 text-zinc-600">
            Once the skill is saved, run it and look at the output. The first run is almost never
            perfect, and that is expected. Tell your agent what is off and have it fix it: a missing
            column, the wrong tone, a competitor you forgot to mention.
          </p>
          <p className="mb-6 text-zinc-600">
            This is the teaching loop. Run it, judge it, fix it. Three rounds usually gets you to
            reliable, and the refinement is where the skill becomes yours.
          </p>

          <h3 id="step-4-refine-until-reliable" className="mb-3 mt-8 text-lg font-semibold text-zinc-800">
            Step 4: Refine until reliable
          </h3>
          <p className="mb-4 text-zinc-600">
            Your skill is saved as plain text files in <code>~/.vellum/workspace/skills/</code>. You
            can:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>Edit the files directly in any text editor</li>
            <li>Ask your agent to tweak it (&quot;Make the verdict column bold&quot;)</li>
            <li>Add reference docs, like a brand voice guide or a glossary</li>
            <li>Add a schedule so it runs automatically</li>
            <li>Share it with other Vellum users</li>
          </ul>
          <p className="mb-6 text-zinc-600">
            A reliable skill is one you trust enough to run without checking the output first. That
            is the payoff: it stops being work you do and becomes work your agent does for you.
          </p>
        </section>

        <hr className="my-8 border-zinc-200" />

        <p className="mb-0 text-zinc-600">
          <em>
            For documentation on every built-in skill, see the{" "}
            <Link href="https://www.vellum.ai/skills" className="font-semibold text-emerald-700 underline hover:text-emerald-800">
              Skills Reference
            </Link>. Or keep going to{" "}
            <a href="/docs/key-concepts" className="font-semibold text-emerald-700 underline hover:text-emerald-800">
              Key Concepts
            </a>{" "}
            to understand how it all fits together.
          </em>
        </p>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
