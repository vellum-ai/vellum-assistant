"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "single-task-commands", label: "Single-task Commands", level: 2 },
  { id: "multi-task-commands", label: "Multi-task / Parallel Commands", level: 2 },
  { id: "plan-execution", label: "Plan Execution (Human-in-the-loop)", level: 2 },
  { id: "utility-review", label: "Utility & Review", level: 2 },
  { id: "typical-flow", label: "Typical Flow", level: 2 },
  { id: "release-pipeline", label: "Release Pipeline", level: 2 },
];

export function DeveloperGuideWorkflowContent() {
  return (
    <>
      <DocsContent title="Development Workflow" breadcrumb="Docs / Developer Guide / Development Workflow">
        <p className="mb-8 text-zinc-600">
          This repo uses Claude Code slash commands (in <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-sm dark:bg-zinc-800">.claude/commands/</code>)
          for agent-driven development. All workflows use squash-merge, worktree isolation for parallel work, and track state
          in <code className="text-sm">.private/TODO.md</code> and <code className="text-sm">.private/UNREVIEWED_PRS.md</code>.
        </p>

        {/* Single-task */}
        <section id="single-task-commands">
          <SectionHeading id="single-task-commands" level={2}>
            Single-task Commands
          </SectionHeading>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-700">
                  <th className="py-2 pr-4 text-left font-medium text-zinc-900 dark:text-zinc-100">Command</th>
                  <th className="py-2 text-left font-medium text-zinc-900 dark:text-zinc-100">Purpose</th>
                </tr>
              </thead>
              <tbody className="text-zinc-600 dark:text-zinc-400">
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4 whitespace-nowrap"><code className="text-xs">/do &lt;description&gt;</code></td>
                  <td className="py-2">Implement a change in an isolated worktree, create a PR, squash-merge to main, clean up.</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4 whitespace-nowrap"><code className="text-xs">/safe-do &lt;description&gt;</code></td>
                  <td className="py-2">Like <code className="text-xs">/do</code> but pauses for human review — no auto-merge.</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4 whitespace-nowrap"><code className="text-xs">/mainline</code></td>
                  <td className="py-2">Ship uncommitted changes to main via a squash-merged PR.</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4 whitespace-nowrap"><code className="text-xs">/ship-and-merge [title]</code></td>
                  <td className="py-2">Ship via PR with automated review feedback loop (up to 3 rounds), then squash-merge.</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4 whitespace-nowrap"><code className="text-xs">/work</code></td>
                  <td className="py-2">Pick up the next task from <code className="text-xs">.private/TODO.md</code>, implement, PR, merge.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* Multi-task */}
        <section id="multi-task-commands" className="mt-12">
          <SectionHeading id="multi-task-commands" level={2}>
            Multi-task / Parallel Commands
          </SectionHeading>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-700">
                  <th className="py-2 pr-4 text-left font-medium text-zinc-900 dark:text-zinc-100">Command</th>
                  <th className="py-2 text-left font-medium text-zinc-900 dark:text-zinc-100">Purpose</th>
                </tr>
              </thead>
              <tbody className="text-zinc-600 dark:text-zinc-400">
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4 whitespace-nowrap"><code className="text-xs">/brainstorm</code></td>
                  <td className="py-2">Deep-read codebase, generate prioritized improvements, update <code className="text-xs">TODO.md</code>.</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4 whitespace-nowrap"><code className="text-xs">/swarm [workers] [max-tasks]</code></td>
                  <td className="py-2">Parallel execution — spawns agents (default: 12) working through <code className="text-xs">TODO.md</code> in isolated worktrees.</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4 whitespace-nowrap"><code className="text-xs">/blitz &lt;feature&gt;</code></td>
                  <td className="py-2">End-to-end feature delivery — plan → issues → swarm → review sweep → merge to main.</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4 whitespace-nowrap"><code className="text-xs">/safe-blitz &lt;feature&gt;</code></td>
                  <td className="py-2">Same as <code className="text-xs">/blitz</code> but on a feature branch with a final PR for manual review.</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4 whitespace-nowrap"><code className="text-xs">/safe-blitz-done [PR|branch]</code></td>
                  <td className="py-2">Finalize a safe-blitz — squash-merge feature branch to main.</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4 whitespace-nowrap"><code className="text-xs">/execute-plan &lt;file&gt;</code></td>
                  <td className="py-2">Sequential multi-PR rollout from a plan file.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* Plan execution */}
        <section id="plan-execution" className="mt-12">
          <SectionHeading id="plan-execution" level={2}>
            Plan Execution (Human-in-the-loop)
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            A three-command workflow for executing plans one PR at a time with human review between each step.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-700">
                  <th className="py-2 pr-4 text-left font-medium text-zinc-900 dark:text-zinc-100">Command</th>
                  <th className="py-2 text-left font-medium text-zinc-900 dark:text-zinc-100">Purpose</th>
                </tr>
              </thead>
              <tbody className="text-zinc-600 dark:text-zinc-400">
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4 whitespace-nowrap"><code className="text-xs">/safe-execute-plan &lt;file&gt;</code></td>
                  <td className="py-2">Create PR, auto-handle Codex/Devin reviews (up to 3 cycles), then await human merge approval.</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4 whitespace-nowrap"><code className="text-xs">/safe-check-review [file]</code></td>
                  <td className="py-2">Check active PR for feedback from all reviewers + CI. Automated feedback loop.</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4 whitespace-nowrap"><code className="text-xs">/resume-plan [file]</code></td>
                  <td className="py-2">Merge current PR, implement next one, stop for review. Repeat until done.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* Utility */}
        <section id="utility-review" className="mt-12">
          <SectionHeading id="utility-review" level={2}>
            Utility & Review
          </SectionHeading>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-700">
                  <th className="py-2 pr-4 text-left font-medium text-zinc-900 dark:text-zinc-100">Command</th>
                  <th className="py-2 text-left font-medium text-zinc-900 dark:text-zinc-100">Purpose</th>
                </tr>
              </thead>
              <tbody className="text-zinc-600 dark:text-zinc-400">
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4 whitespace-nowrap"><code className="text-xs">/plan-html &lt;topic&gt;</code></td>
                  <td className="py-2">Create a rollout plan with markdown + HTML view.</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4 whitespace-nowrap"><code className="text-xs">/release [version]</code></td>
                  <td className="py-2">Cut a release — tag, notes, GitHub Release, CI trigger.</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4 whitespace-nowrap"><code className="text-xs">/triage [user|assistant|device]</code></td>
                  <td className="py-2">Search Sentry errors, cross-reference with Linear issues.</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4 whitespace-nowrap"><code className="text-xs">/update</code></td>
                  <td className="py-2">Pull main, rebuild, launch macOS app.</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4 whitespace-nowrap"><code className="text-xs">/check-reviews [--namespace]</code></td>
                  <td className="py-2">Sweep PRs for review feedback, create follow-up tasks.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* Typical flow */}
        <section id="typical-flow" className="mt-12">
          <SectionHeading id="typical-flow" level={2}>
            Typical Flow
          </SectionHeading>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
{`/brainstorm  →  /swarm  →  /check-reviews  →  /swarm  (repeat)`}
          </pre>
          <p className="mb-4 text-zinc-600">
            Or for a focused feature: <code className="text-sm">/blitz &lt;feature&gt;</code> handles everything in one shot.
            Use <code className="text-sm">/safe-blitz &lt;feature&gt;</code> for a feature branch with a final PR for manual review,
            then <code className="text-sm">/safe-blitz-done</code> to merge.
          </p>
          <p className="mb-4 text-zinc-600">
            For controlled, sequential execution: <code className="text-sm">/safe-execute-plan &lt;file&gt;</code> →{" "}
            <code className="text-sm">/resume-plan</code> → repeat.
          </p>
          <p className="text-sm text-zinc-500">
            <strong>Note:</strong> Slash commands do not run tests, type-checking, or linting by default. These steps are only
            performed when the task specifically requires it.
          </p>
        </section>

        {/* Release */}
        <section id="release-pipeline" className="mt-12">
          <SectionHeading id="release-pipeline" level={2}>
            Release Pipeline
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Run <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-sm dark:bg-zinc-800">/release [version]</code> in Claude Code.
            If no version is provided, the patch version auto-increments from the latest tag.
          </p>
          <p className="mb-4 text-zinc-600">
            Creating a GitHub Release triggers three workflows in parallel:
          </p>
          <ol className="mb-4 list-decimal space-y-3 pl-6 text-zinc-600">
            <li>
              <strong>macOS App</strong> — build from source, compile Bun binary, code-sign with Developer ID, notarize with Apple,
              create DMG, publish to the public updates repo (~15–20 min).
            </li>
            <li>
              <strong>npm</strong> — publish the <code className="text-sm">velly</code> CLI package with provenance.
            </li>
            <li>
              <strong>Slack</strong> — post release summary with threaded changelog.
            </li>
          </ol>
          <p className="mb-4 text-zinc-600">
            Existing macOS installations auto-update via Sparkle&apos;s <code className="text-sm">appcast.xml</code> feed.
            New users download the latest DMG from the{" "}
            <a href="https://github.com/vellum-ai/vellum-assistant/releases/latest" className="text-emerald-600 hover:text-emerald-500 dark:text-emerald-400">
              public updates repo
            </a>.
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
