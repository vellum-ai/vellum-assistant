"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "what-it-does", label: "What it does", level: 2 },
  { id: "setup-required", label: "Setup required", level: 2 },
  { id: "permissions", label: "Permissions", level: 2 },
  { id: "common-prompts", label: "Common prompts", level: 2 },
  { id: "spawn-modes", label: "Spawn modes", level: 2 },
  { id: "roles", label: "Roles", level: 2 },
  { id: "working-with-subagents", label: "Working with a subagent", level: 2 },
  { id: "configuration", label: "Configuration", level: 2 },
  { id: "tips-gotchas", label: "Tips & gotchas", level: 2 },
];

export function SkillsReferenceSubagentContent() {
  return (
    <>
      <DocsContent
        title="Subagent"
        breadcrumb="Docs / Skills Reference / Subagent"
      >
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-3 text-zinc-600">
            Spawns autonomous background agents (subagents) that work
            independently while your main conversation keeps going. Your
            assistant can fan a single request out into several workers at once:
            research one thing while it drafts another, investigate a problem
            off to the side, or pull in a second opinion before committing to an
            approach.
          </p>
          <p className="mb-0 text-zinc-600">
            Each subagent runs in its own context with its own task, so heavy
            work like deep research, multi-file exploration, and long-running
            monitoring happens without crowding out your chat. Your assistant
            decides when delegating is worth it and reports back when a subagent
            finishes.
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
              Subagents inherit the same permission rules as your main
              assistant.
            </li>
            <li>
              Each subagent gets a <strong>role</strong> that scopes which tools
              it can use, so a worker only has the access its task needs.
            </li>
            <li>
              Only the conversation that started a subagent can check on it,
              message it, or stop it.
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
                    &ldquo;Spawn an agent to research AI startups in
                    healthcare&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Launches a background researcher
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Research the options while you start on the
                    migration&rdquo;
                  </td>
                  <td className="px-3 py-2">Runs two subagents in parallel</td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Dig into why this build keeps failing&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Delegates to an investigator for root-cause analysis
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Get a second opinion on this plan before we build
                    it&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Consults the advisor and waits for its guidance
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Check on my research agent&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Gets the status of a running subagent
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Cancel the background agent&rdquo;
                  </td>
                  <td className="px-3 py-2">Aborts a running subagent</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section id="spawn-modes" className="mt-12">
          <SectionHeading id="spawn-modes" level={2}>
            Spawn modes
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            There are three ways a subagent can start. Your assistant picks the
            right one for the task, and you can also ask for a specific one.
          </p>
          <div className="mb-4 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-zinc-50">
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    Mode
                  </th>
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    How it runs
                  </th>
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    What it knows
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50">
                <tr>
                  <td className="px-3 py-2">
                    <strong>Regular</strong>
                  </td>
                  <td className="px-3 py-2">
                    In the background, in parallel with your conversation
                  </td>
                  <td className="px-3 py-2">
                    Only the objective and context it&apos;s given
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    <strong>Fork</strong>
                  </td>
                  <td className="px-3 py-2">
                    In the background, in parallel with your conversation
                  </td>
                  <td className="px-3 py-2">
                    Inherits your full conversation (messages, context, and
                    memory)
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    <strong>Advisor</strong>
                  </td>
                  <td className="px-3 py-2">
                    Synchronously (your assistant waits for its answer)
                  </td>
                  <td className="px-3 py-2">
                    Inherits your full context; runs on a more capable model and
                    returns guidance
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Regular.</strong> For self-contained work with a clear
              objective. The subagent doesn&apos;t need to know what you&apos;ve
              been discussing.
            </li>
            <li>
              <strong>Fork.</strong> For work that builds on the conversation so
              far (&ldquo;dig deeper on what we just found&rdquo;). A fork
              shares your context instead of having it re-explained.
            </li>
            <li>
              <strong>Advisor.</strong> A one-shot, read-only second opinion,
              and the one kind your assistant reaches for on its own judgment:
              to pressure-test a plan, when it&apos;s stuck, or as a final check
              before calling a task done. It has no tools; it reasons from your
              context and replies with focused guidance.
            </li>
          </ul>
        </section>

        <section id="roles" className="mt-12">
          <SectionHeading id="roles" level={2}>
            Roles
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Every subagent runs with a role that determines which tools it can
            touch. Your assistant picks the most restrictive role that can still
            do the job, which keeps each worker&apos;s blast radius small.
          </p>
          <div className="mb-0 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-zinc-50">
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    Role
                  </th>
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    Best for
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50">
                <tr>
                  <td className="px-3 py-2">
                    <strong>Researcher</strong>
                  </td>
                  <td className="px-3 py-2">
                    Web and document research, reading and gathering information
                    (read-only)
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    <strong>Coder</strong>
                  </td>
                  <td className="px-3 py-2">
                    Writing and editing files, running commands, build and test
                    work
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    <strong>Planner</strong>
                  </td>
                  <td className="px-3 py-2">
                    Analysis, planning, and synthesizing information (read-only)
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    <strong>Investigator</strong>
                  </td>
                  <td className="px-3 py-2">
                    Root-cause analysis and debugging; returns a compact
                    findings report (read-only)
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    <strong>Advisor</strong>
                  </td>
                  <td className="px-3 py-2">
                    A no-tools, one-shot strategic review
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    <strong>General</strong>
                  </td>
                  <td className="px-3 py-2">
                    Unrestricted access, used only when a task genuinely needs
                    it
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section id="working-with-subagents" className="mt-12">
          <SectionHeading id="working-with-subagents" level={2}>
            Working with a subagent
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            A subagent follows a simple lifecycle: it starts pending, then runs,
            and ends completed, failed, or aborted. You don&apos;t have to watch
            for the finish. Your assistant is notified automatically when a
            subagent ends and follows up with the result.
          </p>
          <p className="mb-3 text-zinc-600">
            While one is running, you can stay in the loop:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Check status.</strong> Ask how a worker is doing, or what
              all of them are up to.
            </li>
            <li>
              <strong>Read its output.</strong> Pull back what a subagent
              produced once it finishes.
            </li>
            <li>
              <strong>Send a follow-up.</strong> Hand a running subagent new
              instructions or a course correction.
            </li>
            <li>
              <strong>Cancel it.</strong> Stop a subagent you no longer need.
            </li>
            <li>
              <strong>Name it.</strong> Give a subagent a memorable label
              (&ldquo;the auth research&rdquo;) so it&apos;s easy to refer back
              to.
            </li>
          </ul>
          <p className="mb-0 text-zinc-600">
            Subagents can also reach back on their own. They can surface an
            interim finding, flag an important result, or signal that
            they&apos;re blocked and need a decision, so you can act on partial
            progress instead of waiting for the whole task to finish.
          </p>
        </section>

        <section id="configuration" className="mt-12">
          <SectionHeading id="configuration" level={2}>
            Configuration
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Silent mode.</strong> A subagent&apos;s result can be
              handled internally by your assistant instead of shown to you, for
              work that&apos;s a means to an end. Forks are silent by default.
            </li>
            <li>
              <strong>Model selection.</strong> A subagent can run under a
              specific model profile. By default it inherits the one your
              conversation is using.
            </li>
            <li>
              <strong>Status tracking.</strong> Pending, running, completed,
              failed, aborted.
            </li>
            <li>
              <strong>Results.</strong> Delivered back through your assistant as
              a follow-up once a subagent finishes.
            </li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Genuinely parallel.</strong> Regular subagents and forks
              run in the background while you keep chatting, and you can have
              several going at once.
            </li>
            <li>
              <strong>Context is a choice.</strong> A regular subagent starts
              fresh and only knows what it&apos;s given. Use a fork when the
              task needs to know what you&apos;ve been discussing.
            </li>
            <li>
              <strong>Smaller is better.</strong> A few focused subagents finish
              faster and fail more gracefully than one large general-purpose
              one.
            </li>
            <li>
              <strong>No need to poll.</strong> Your assistant is notified
              automatically when a subagent completes, so you don&apos;t have to
              keep asking.
            </li>
            <li>
              <strong>One level deep.</strong> Subagents can&apos;t spawn their
              own subagents, which keeps delegation predictable.
            </li>
            <li>
              <strong>Great for long tasks.</strong> Deep research, monitoring,
              and batch processing are ideal use cases.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
