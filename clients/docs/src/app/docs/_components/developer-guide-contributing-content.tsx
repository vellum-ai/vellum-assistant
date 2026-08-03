"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "prerequisites", label: "Prerequisites", level: 2 },
  { id: "local-setup", label: "Local Development Setup", level: 2 },
  { id: "repo-structure", label: "Repository Structure", level: 3 },
  { id: "running-the-assistant", label: "Running the Assistant", level: 3 },
  { id: "running-from-source", label: "Running from Source", level: 3 },
  { id: "testing", label: "Testing", level: 2 },
  { id: "running-tests", label: "Running Tests", level: 3 },
  { id: "type-checking", label: "Type Checking", level: 3 },
  { id: "writing-tests", label: "Writing Tests", level: 3 },
  { id: "code-style", label: "Code Style & Linting", level: 2 },
  { id: "git-hooks", label: "Git Hooks", level: 3 },
  { id: "imports", label: "Import Conventions", level: 3 },
  { id: "submitting-a-pr", label: "Submitting a PR", level: 2 },
  { id: "pr-conventions", label: "PR Conventions", level: 3 },
  { id: "review-process", label: "Review Process", level: 3 },
  { id: "keeping-docs-current", label: "Keeping Docs Current", level: 2 },
  { id: "backwards-compatibility", label: "Backwards Compatibility", level: 2 },
];

export function DeveloperGuideContributingContent() {
  return (
    <>
      <DocsContent title="Contributing" breadcrumb="Docs / Developer Guide / Contributing">
        <p className="mb-8 text-zinc-600">
          Everything you need to set up the Vellum Assistant repo locally, run tests, and submit a pull request.
          Whether you&apos;re fixing a bug, adding a feature, or improving docs — this page has you covered.
        </p>

        {/* Prerequisites */}
        <section id="prerequisites">
          <SectionHeading id="prerequisites" level={2}>
            Prerequisites
          </SectionHeading>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong><a href="https://bun.sh" className="text-emerald-600 hover:text-emerald-500 dark:text-emerald-400">Bun</a></strong> — the
              only hard requirement. The setup script handles everything else.
            </li>
            <li>
              <strong>macOS or Linux</strong> — the assistant runtime supports both. macOS uses{" "}
              <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-sm dark:bg-zinc-800">sandbox-exec</code> for sandboxing,
              Linux uses <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-sm dark:bg-zinc-800">bwrap</code> (bubblewrap).
            </li>
            <li>
              <strong>Git</strong> — the setup script configures custom git hooks automatically.
            </li>
          </ul>
          <p className="text-sm text-zinc-500">
            Docker Desktop is optional but needed if you want full sandbox isolation on Linux. On macOS, the native{" "}
            <code className="text-sm">sandbox-exec</code> is used and requires no extra setup.
          </p>
        </section>

        {/* Local Development Setup */}
        <section id="local-setup" className="mt-12">
          <SectionHeading id="local-setup" level={2}>
            Local Development Setup
          </SectionHeading>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
{`git clone https://github.com/vellum-ai/vellum-assistant.git
cd vellum-assistant
./setup.sh`}
          </pre>
          <p className="mb-4 text-zinc-600">
            The setup script will:
          </p>
          <ol className="mb-4 list-decimal space-y-2 pl-6 text-zinc-600">
            <li>Configure git to use <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-sm dark:bg-zinc-800">.githooks/</code> for pre-commit and pre-push hooks</li>
            <li>Install dependencies for each package (<code className="text-sm">assistant</code>, <code className="text-sm">cli</code>, <code className="text-sm">gateway</code>, <code className="text-sm">credential-executor</code>, <code className="text-sm">scripts</code>)</li>
            <li>Register local packages as linkable and wire them together via <code className="text-sm">bun link</code></li>
            <li>Link the global <code className="text-sm">vellum</code> CLI so it&apos;s available from anywhere</li>
            <li>Install shell completions for Bash and Zsh</li>
          </ol>

          <section id="repo-structure" className="mt-6">
            <SectionHeading id="repo-structure" level={3}>
              Repository Structure
            </SectionHeading>
            <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
{`├── assistant/            # Bun-based assistant runtime (core logic, HTTP API)
├── cli/                  # Vellum CLI (multi-assistant management)
├── clients/              # Native macOS client (menu bar app)
├── gateway/              # Channel gateway (Telegram, Twilio, OAuth, reverse proxy)
├── credential-executor/  # Credential Execution Service (isolated RPC)
├── packages/             # Shared private packages
├── skills/               # Bundled skill definitions
├── scripts/              # Utility scripts (publishing, tunneling, releases)
├── benchmarking/         # Load testing scripts
├── meta/                 # Meta configuration
├── .claude/              # Claude Code slash commands and workflow tools
└── .github/              # GitHub Actions workflows`}
            </pre>
            <p className="text-sm text-zinc-500">
              Each top-level package has its own <code className="text-sm">AGENTS.md</code> with package-specific conventions.
              Check the relevant one before making changes in that area.
            </p>
          </section>

          <section id="running-the-assistant" className="mt-6">
            <SectionHeading id="running-the-assistant" level={3}>
              Running the Assistant
            </SectionHeading>
            <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
{`vellum hatch            # first-time setup (creates config, provisions keys)
vellum wake             # start assistant + gateway
vellum ps               # check process status
vellum sleep            # stop everything
vellum terminal         # shell into a managed assistant container
vellum doctor           # diagnose issues`}
            </pre>
          </section>

          <section id="running-from-source" className="mt-6">
            <SectionHeading id="running-from-source" level={3}>
              Running from Source
            </SectionHeading>
            <p className="mb-4 text-zinc-600">
              For development, you can run the assistant directly without the CLI wrapper:
            </p>
            <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
{`export PATH="$HOME/.bun/bin:$PATH"
cd assistant
bun install
bun run src/index.ts assistant start`}
            </pre>
            <p className="text-sm text-zinc-500">
              Some dependencies (<code className="text-sm">agentmail</code>,{" "}
              <code className="text-sm">@pydantic/logfire-node</code>) are optional at runtime but required
              for full <code className="text-sm">tsc --noEmit</code> type-checking.
            </p>
          </section>
        </section>

        {/* Testing */}
        <section id="testing" className="mt-12">
          <SectionHeading id="testing" level={2}>
            Testing
          </SectionHeading>

          <section id="running-tests" className="mt-6">
            <SectionHeading id="running-tests" level={3}>
              Running Tests
            </SectionHeading>
            <p className="mb-4 text-zinc-600">
              The full test suite is large. <strong>Never run <code className="text-sm">bun test</code> without specifying file paths</strong> — it
              will hang or timeout.
            </p>
            <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
{`# Run tests for specific files you changed
cd assistant && bun test src/path/to/file.test.ts

# Run tests matching a pattern
cd assistant && bun test src/path/to/file.test.ts --grep "pattern"

# Type-check the full project (preferred over running all tests)
cd assistant && bunx tsc --noEmit`}
            </pre>
            <p className="text-sm text-zinc-500">
              The pre-push hook automatically finds and runs tests matching changed source files, so you&apos;ll get
              coverage feedback before pushing.
            </p>
          </section>

          <section id="type-checking" className="mt-6">
            <SectionHeading id="type-checking" level={3}>
              Type Checking
            </SectionHeading>
            <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
{`cd assistant && bunx tsc --noEmit`}
            </pre>
            <p className="mb-4 text-zinc-600">
              This is the fastest way to validate your changes across the full project. The pre-push hook also runs this
              automatically when TypeScript files are changed.
            </p>
          </section>

          <section id="writing-tests" className="mt-6">
            <SectionHeading id="writing-tests" level={3}>
              Writing Tests
            </SectionHeading>
            <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
              <li>Place test files next to the source: <code className="text-sm">src/path/to/file.test.ts</code></li>
              <li>Use <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-sm dark:bg-zinc-800">test.todo(&quot;description&quot;, () =&gt; {'{}'})
              </code> for tests that reproduce unfixed bugs — never commit failing <code className="text-sm">test()</code> cases</li>
              <li>Convert <code className="text-sm">test.todo</code> to <code className="text-sm">test</code> when the fix lands</li>
              <li>Look at existing tests in the same directory for patterns and conventions</li>
            </ul>
          </section>
        </section>

        {/* Code Style */}
        <section id="code-style" className="mt-12">
          <SectionHeading id="code-style" level={2}>
            Code Style &amp; Linting
          </SectionHeading>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
{`cd assistant && bun run lint    # Run ESLint`}
          </pre>

          <section id="git-hooks" className="mt-6">
            <SectionHeading id="git-hooks" level={3}>
              Git Hooks
            </SectionHeading>
            <p className="mb-4 text-zinc-600">
              Git hooks are configured automatically by <code className="text-sm">setup.sh</code>. They run on every commit and push:
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 dark:border-zinc-700">
                    <th className="py-2 pr-4 text-left font-medium text-zinc-900 dark:text-zinc-100">Hook</th>
                    <th className="py-2 text-left font-medium text-zinc-900 dark:text-zinc-100">What It Does</th>
                  </tr>
                </thead>
                <tbody className="text-zinc-600 dark:text-zinc-400">
                  <tr className="border-b border-zinc-100 dark:border-zinc-800">
                    <td className="py-2 pr-4 font-medium">pre-commit</td>
                    <td className="py-2">Secret scanning, Prettier formatting, ESLint, message contract verification, tool registration guard</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-medium">pre-push</td>
                    <td className="py-2">TypeScript type check, ESLint on changed files, runs related test files</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="mt-4 text-sm text-zinc-500">
              Bypass with <code className="text-sm">--no-verify</code> in exceptional cases, but this is strongly discouraged.
              See{" "}
              <a href="https://github.com/vellum-ai/vellum-assistant/blob/main/.githooks/README.md" className="text-emerald-600 hover:text-emerald-500 dark:text-emerald-400">
                .githooks/README.md
              </a>{" "}
              for full details.
            </p>
          </section>

          <section id="imports" className="mt-6">
            <SectionHeading id="imports" level={3}>
              Import Conventions
            </SectionHeading>
            <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
              <li>All imports use <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-sm dark:bg-zinc-800">.js</code> extensions (NodeNext module resolution)</li>
              <li>Use <code className="text-sm">bun install</code> for dependencies — each package has its own <code className="text-sm">bun.lock</code></li>
              <li>Ensure <code className="text-sm">PATH</code> includes Bun: <code className="text-sm">export PATH=&quot;$HOME/.bun/bin:$PATH&quot;</code></li>
            </ul>
          </section>
        </section>

        {/* Submitting a PR */}
        <section id="submitting-a-pr" className="mt-12">
          <SectionHeading id="submitting-a-pr" level={2}>
            Submitting a PR
          </SectionHeading>

          <section id="pr-conventions" className="mt-6">
            <SectionHeading id="pr-conventions" level={3}>
              PR Conventions
            </SectionHeading>
            <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
              <li><strong>Squash-merge only</strong> — all PRs are squash-merged into main</li>
              <li><strong>Worktree isolation</strong> — parallel work uses git worktrees to avoid conflicts</li>
              <li><strong>Dead code removal</strong> — proactively remove unused code in every change. Ask yourself: &ldquo;After my change, is there any code nothing calls?&rdquo;</li>
              <li><strong>Linear tickets</strong> — if your PR relates to a Linear issue, include the identifier (e.g. <code className="text-sm">JARVIS-123</code>) in
                the branch name and use <code className="text-sm">Closes JARVIS-123</code> in the commit body for auto-close</li>
            </ul>
          </section>

          <section id="review-process" className="mt-6">
            <SectionHeading id="review-process" level={3}>
              Review Process
            </SectionHeading>
            <p className="mb-4 text-zinc-600">
              PRs go through automated review (Codex/Devin) with up to 3 fix cycles before human review. The automated reviewers check for:
            </p>
            <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
              <li>Type safety and correctness</li>
              <li>Test coverage for changed code</li>
              <li>Adherence to project conventions</li>
              <li>Backwards compatibility</li>
            </ul>
            <p className="mb-4 text-zinc-600">
              For non-routine changes (architectural decisions, security, complex logic, deletions), leave a PR comment
              highlighting where to focus review and the risk level.
            </p>
          </section>
        </section>

        {/* Keeping Docs Current */}
        <section id="keeping-docs-current" className="mt-12">
          <SectionHeading id="keeping-docs-current" level={2}>
            Keeping Docs Current
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            When your PR changes behavior, update the relevant docs in the same PR:
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-700">
                  <th className="py-2 pr-4 text-left font-medium text-zinc-900 dark:text-zinc-100">What Changed</th>
                  <th className="py-2 text-left font-medium text-zinc-900 dark:text-zinc-100">What to Update</th>
                </tr>
              </thead>
              <tbody className="text-zinc-600 dark:text-zinc-400">
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4">Slash commands in <code className="text-xs">.claude/commands/</code></td>
                  <td className="py-2">README&apos;s &ldquo;Slash Commands&rdquo; section</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4">Services, modules, or data flows</td>
                  <td className="py-2"><code className="text-xs">ARCHITECTURE.md</code> and impacted domain docs</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4">New project-wide patterns or constraints</td>
                  <td className="py-2"><code className="text-xs">AGENTS.md</code></td>
                </tr>
                <tr>
                  <td className="py-2 pr-4">User/assistant-facing features</td>
                  <td className="py-2"><code className="text-xs">assistant/src/prompts/templates/UPDATES.md</code></td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* Backwards Compatibility */}
        <section id="backwards-compatibility" className="mt-12">
          <SectionHeading id="backwards-compatibility" level={2}>
            Backwards Compatibility
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Vellum has real users — maintain backwards compatibility for all interfaces, persisted state, and data.
            Never ship a change that silently breaks existing behavior.
          </p>
          <p className="mb-4 text-zinc-600">
            When a change alters workspace file paths, directory structure, data shapes, or storage formats, include a migration in the same PR:
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-700">
                  <th className="py-2 pr-4 text-left font-medium text-zinc-900 dark:text-zinc-100">What Changed</th>
                  <th className="py-2 pr-4 text-left font-medium text-zinc-900 dark:text-zinc-100">Migration Type</th>
                  <th className="py-2 text-left font-medium text-zinc-900 dark:text-zinc-100">Location</th>
                </tr>
              </thead>
              <tbody className="text-zinc-600 dark:text-zinc-400">
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4">Workspace files (renames, moves, format changes)</td>
                  <td className="py-2 pr-4">Workspace migration</td>
                  <td className="py-2"><code className="text-xs">assistant/src/workspace/migrations/</code></td>
                </tr>
                <tr>
                  <td className="py-2 pr-4">Database schema or data</td>
                  <td className="py-2 pr-4">DB migration</td>
                  <td className="py-2"><code className="text-xs">assistant/src/memory/migrations/</code></td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-sm text-zinc-500">
            Migrations must be idempotent (safe to re-run) and append-only (never reorder or remove existing entries).
            Flag breaking changes in PR descriptions.
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
