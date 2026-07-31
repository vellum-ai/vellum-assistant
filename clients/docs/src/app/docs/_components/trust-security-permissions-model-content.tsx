"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "how-it-works", label: "How it works", level: 2 },
  { id: "risk-tolerance", label: "Risk tolerance", level: 2 },
  { id: "per-context-thresholds", label: "Per-context thresholds", level: 3 },
  { id: "the-permission-prompt", label: "The permission prompt", level: 2 },
  { id: "the-sandbox-boundary", label: "The sandbox boundary", level: 2 },
  { id: "how-shell-commands-are-classified", label: "How shell commands are classified", level: 2 },
  { id: "trust-rules", label: "Trust rules", level: 2 },
  { id: "the-rule-editor", label: "The Rule Editor", level: 3 },
  { id: "directory-scoped-rules", label: "Directory-scoped rules", level: 3 },
  { id: "skill-tool-permissions", label: "Skill tool permissions", level: 2 },
  { id: "macos-system-permissions", label: "macOS system permissions", level: 2 },
  { id: "cross-channel-approvals", label: "Cross-channel approvals", level: 2 },
  { id: "what-happens-when-you-say-no", label: "What happens when you say no", level: 2 },
];

export function TrustSecurityPermissionsModelContent() {
  return (
    <>
      <DocsContent
        title="The Permissions Model"
        breadcrumb="Docs / Trust & Security / The Permissions Model"
      >
        <p className="mb-4 text-zinc-600">
          Your assistant can read files, run commands, browse the web, and control
          your screen. The permissions model controls which of those actions happen
          automatically and which ones need your approval.
        </p>
        <p className="mb-8 text-zinc-600">
          Every permission check is deterministic, enforced by traditional software,
          not judged by the AI. The approval buttons you see are hard-coded responses,
          not natural language interpreted by the model. This means there&apos;s no way
          to prompt-inject past a permission boundary.
        </p>

        <section id="how-it-works">
          <SectionHeading id="how-it-works" level={2}>
            How it works
          </SectionHeading>
          <p className="mb-3 text-zinc-600">
            Every tool your assistant uses is classified with a risk level:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Low</strong>: read-only operations (reading workspace files, web
              searches, loading skills, recalling memories). These run automatically at
              the default risk tolerance.
            </li>
            <li>
              <strong>Medium</strong>: operations that change state (writing files, making
              API calls, running shell commands that modify things). Whether these prompt
              you depends on your risk tolerance setting.
            </li>
            <li>
              <strong>High</strong>: destructive or sensitive operations (deleting files,
              modifying skill source code, running sudo). These always prompt you unless
              you&apos;ve set your risk tolerance to Full access.
            </li>
          </ul>
          <p className="mb-3 text-zinc-600">
            Risk classification runs in the gateway, a separate, deterministic process
            outside the AI sandbox. Shell commands are parsed using a tree-sitter parser;
            other tools are classified based on their registry metadata.
          </p>
          <p className="mb-3 text-zinc-600">
            When a tool needs your approval, you see:
          </p>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>A description of what it wants to do, in plain language</li>
            <li>A color-coded risk badge (🟢 Low / 🟡 Medium / 🔴 High)</li>
            <li>The risk reason: why the classifier assigned that level</li>
            <li>An expandable &ldquo;Show details&rdquo; section with the full tool input</li>
          </ul>
        </section>

        <section id="risk-tolerance" className="mt-12">
          <SectionHeading id="risk-tolerance" level={2}>
            Risk tolerance
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Your risk tolerance controls the threshold below which actions auto-approve
            without prompting. You can configure it in Settings &gt; Permissions &amp; Privacy.
          </p>
          <div className="mb-4 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-zinc-50">
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    Setting
                  </th>
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    What auto-approves
                  </th>
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    What prompts
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50">
                <tr>
                  <td className="px-3 py-2">
                    <strong>🔒 Strict</strong>
                  </td>
                  <td className="px-3 py-2">Nothing</td>
                  <td className="px-3 py-2">
                    Everything: every action requires explicit approval
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    <strong>🛡️ Default</strong>
                  </td>
                  <td className="px-3 py-2">Low-risk actions</td>
                  <td className="px-3 py-2">
                    Medium and High-risk actions (reading files and web searches auto-approve; writes, commands, and API calls prompt)
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    <strong>⚠️ Relaxed</strong>
                  </td>
                  <td className="px-3 py-2">Low and Medium-risk actions</td>
                  <td className="px-3 py-2">
                    High-risk actions only (file writes and workspace commands auto-approve; destructive operations still prompt)
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    <strong>🚫 Full access</strong>
                  </td>
                  <td className="px-3 py-2">Everything</td>
                  <td className="px-3 py-2">
                    Nothing: your assistant never asks for permission
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mb-0 text-zinc-600">
            The default setting is <strong>Default</strong>, which auto-approves low-risk
            read-only operations and prompts for everything else.
          </p>

          <section id="per-context-thresholds" className="mt-8">
            <SectionHeading id="per-context-thresholds" level={3}>
              Per-context thresholds
            </SectionHeading>
            <p className="mb-3 text-zinc-600">
              Under the Advanced section in Settings, you can set different thresholds
              for different execution contexts:
            </p>
            <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
              <li>
                <strong>When chatting</strong>: interactive conversation sessions
                (default: Default)
              </li>
              <li>
                <strong>Scheduled tasks</strong>: background tasks like heartbeats and
                scheduled jobs (default: Relaxed)
              </li>
              <li>
                <strong>Automation / API</strong>: externally triggered via API or webhooks
                (default: Strict)
              </li>
            </ul>
            <p className="mb-0 text-zinc-600">
              This lets you give your assistant more autonomy for background tasks it runs
              on its own, while keeping tighter controls on API-triggered actions where
              external callers are involved.
            </p>
          </section>
        </section>

        <section id="the-permission-prompt" className="mt-12">
          <SectionHeading id="the-permission-prompt" level={2}>
            The permission prompt
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            When an action exceeds your risk tolerance, you see a permission prompt
            with two options:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Allow</strong>: approve this action. If the system has a
              pattern match for the action (e.g. <code>git push *</code>), clicking
              Allow also creates a trust rule so similar actions auto-approve in
              the future.
            </li>
            <li>
              <strong>Deny</strong>: block this action.
            </li>
          </ul>
          <p className="mb-4 text-zinc-600">
            The Allow button has a split menu with an additional option:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Allow &amp; Create Rule</strong>: approve the action and open
              the Rule Editor, where you can customize the trust rule before it&apos;s
              saved. The Rule Editor is pre-populated with an LLM-suggested pattern
              and scope.
            </li>
          </ul>
          <p className="mb-0 text-zinc-600">
            Every completed tool call (including auto-approved ones) shows a risk
            badge in the expanded view. Clicking the badge opens the Rule Editor,
            letting you proactively create or adjust rules from any tool call.
          </p>
        </section>

        <section id="the-sandbox-boundary" className="mt-12">
          <SectionHeading id="the-sandbox-boundary" level={2}>
            The sandbox boundary
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Think of your assistant&apos;s workspace as a separate computer inside your
            computer. It&apos;s a self-contained environment where the assistant can run
            freely (creating files, modifying data, running commands) without needing
            your approval. Anything that happens inside this inner computer stays contained.
          </p>
          <p className="mb-2 text-zinc-600">
            <strong>Inside the workspace</strong> (<code>~/.vellum/workspace/</code>):
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>Reading, writing, and editing files: no approval needed</li>
            <li>Running shell commands via <strong>bash</strong>: no approval needed (sandboxed execution)</li>
            <li>Building apps, saving memories, searching the web: no approval needed</li>
          </ul>
          <p className="mb-2 text-zinc-600">
            <strong>Outside the workspace</strong> (your host machine):
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>host_file_read</strong>: reading files anywhere on your machine.
              Prompted.
            </li>
            <li>
              <strong>host_file_write, host_file_edit</strong>: writing or editing files
              anywhere. Prompted.
            </li>
            <li>
              <strong>host_bash</strong>: running shell commands on your actual machine.
              Prompted.
            </li>
          </ul>
          <p className="mb-4 text-zinc-600">
            When the assistant needs to do something outside its workspace, it doesn&apos;t
            reach out directly. Instead, it tells a separate process, one that lives outside the sandbox, to perform the action and report back. That external
            process is deterministic, traditional software with no AI involved. The AI
            stays inside the cage at all times.
          </p>
          <p className="mb-0 text-zinc-600">
            The sandbox is enforced at the OS level (sandbox-exec on macOS, bubblewrap on
            Linux). Path traversal attacks (using <code>../</code> to escape the workspace)
            and symlink escapes are blocked.
          </p>
        </section>

        <section id="how-shell-commands-are-classified" className="mt-12">
          <SectionHeading id="how-shell-commands-are-classified" level={2}>
            How shell commands are classified
          </SectionHeading>
          <p className="mb-3 text-zinc-600">
            Not all shell commands are equal. Your assistant parses commands using a
            tree-sitter parser and classifies them based on what programs they invoke:
          </p>
          <p className="mb-3 text-zinc-600">
            <strong>Low risk</strong> (read-only programs):{" "}
            <code>ls</code>, <code>cat</code>, <code>grep</code>, <code>find</code>,{" "}
            <code>git status</code>, <code>git log</code>, <code>git diff</code>,{" "}
            <code>node</code>, <code>python</code>, <code>jq</code>, <code>tree</code>,{" "}
            <code>du</code>, <code>df</code>, <code>ping</code>, <code>dig</code>, and
            similar.
          </p>
          <p className="mb-3 text-zinc-600">
            <strong>Medium risk</strong> (programs that modify state):{" "}
            <code>sed</code>, <code>awk</code>, <code>chmod</code>, <code>chown</code>,{" "}
            <code>curl</code>, <code>wget</code>, non-read-only git subcommands (like{" "}
            <code>git commit</code>, <code>git push</code>), and any program not in the
            known-safe list.
          </p>
          <p className="mb-4 text-zinc-600">
            <strong>High risk</strong> (dangerous programs):{" "}
            <code>sudo</code>, <code>rm</code>, <code>dd</code>, <code>mkfs</code>,{" "}
            <code>reboot</code>, <code>shutdown</code>, <code>kill</code>,{" "}
            <code>iptables</code>, and other system administration tools.
          </p>
          <p className="mb-0 text-zinc-600">
            This parsing also generates &ldquo;action keys&rdquo; for pattern matching.
            When you approve <code>git push</code>, the system creates a rule that matches
            future <code>git push</code> commands without also matching{" "}
            <code>git reset --hard</code>.
          </p>
        </section>

        <section id="trust-rules" className="mt-12">
          <SectionHeading id="trust-rules" level={2}>
            Trust rules
          </SectionHeading>
          <p className="mb-3 text-zinc-600">
            Trust rules are persistent decisions that tell the system to always allow
            or always deny specific actions. They accumulate over time as you use your
            assistant: the more you approve, the fewer prompts you see.
          </p>
          <p className="mb-3 text-zinc-600">Each rule has:</p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Tool</strong>: which tool it applies to
            </li>
            <li>
              <strong>Pattern</strong>: a glob pattern matching specific commands, paths,
              or URLs
            </li>
            <li>
              <strong>Risk level</strong>: the classified risk of the action
            </li>
            <li>
              <strong>Scope</strong>: where the rule applies (a specific directory, the
              project root, or everywhere)
            </li>
            <li>
              <strong>Decision</strong>: allow, deny, or ask
            </li>
          </ul>
          <p className="mb-4 text-zinc-600">
            Rules are matched using glob patterns. You can have a broad
            &ldquo;allow git everywhere&rdquo; rule and a narrow &ldquo;deny{" "}
            <code>git push --force</code> everywhere&rdquo; rule, and the deny will win
            because deny takes precedence over allow at equal priority.
          </p>
          <p className="mb-0 text-zinc-600">
            You can view and manage your trust rules in Settings &gt; Permissions &amp; Privacy.
          </p>

          <section id="the-rule-editor" className="mt-8">
            <SectionHeading id="the-rule-editor" level={3}>
              The Rule Editor
            </SectionHeading>
            <p className="mb-4 text-zinc-600">
              The Rule Editor opens when you click &ldquo;Allow &amp; Create Rule&rdquo;
              on a permission prompt, or when you click the risk badge on any completed
              tool call. It lets you customize exactly what the rule matches before saving.
            </p>
            <p className="mb-3 text-zinc-600">
              The Rule Editor shows:
            </p>
            <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
              <li>
                <strong>Pattern options</strong>: a ladder of patterns from most specific
                (exact command) to most general (any command from that program), generated
                by the command parser
              </li>
              <li>
                <strong>Scope options</strong>: where the rule should apply (this specific
                directory, the project root, or everywhere)
              </li>
              <li>
                <strong>Risk level</strong>: the classified risk, so you understand what
                you&apos;re allowing
              </li>
            </ul>
            <p className="mb-0 text-zinc-600">
              When opened via &ldquo;Allow &amp; Create Rule,&rdquo; the fields are
              pre-populated with an LLM-suggested pattern and scope based on the action
              you&apos;re approving. You can adjust anything before saving.
            </p>
          </section>

          <section id="directory-scoped-rules" className="mt-8">
            <SectionHeading id="directory-scoped-rules" level={3}>
              Directory-scoped rules
            </SectionHeading>
            <p className="mb-4 text-zinc-600">
              Trust rules can be scoped to specific directories. For example, you might
              allow <code>git push</code> in your work project but not in your personal
              dotfiles. When a tool operates on files, the system resolves the
              actual filesystem paths and checks them against directory-scoped rules.
            </p>
            <p className="mb-0 text-zinc-600">
              The default scope is &ldquo;Everywhere,&rdquo; which means the rule applies
              regardless of which directory the action targets. You can narrow this in the
              Rule Editor to scope rules to a specific project.
            </p>
          </section>
        </section>

        <section id="skill-tool-permissions" className="mt-12">
          <SectionHeading id="skill-tool-permissions" level={2}>
            Skill tool permissions
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Tools provided by third-party skills (ones you&apos;ve installed, not the ones
            bundled with Vellum) are always prompted by default, regardless of risk level.
            This prevents a malicious or buggy skill from executing actions without your
            knowledge.
          </p>
          <p className="mb-4 text-zinc-600">
            Bundled skill tools (Browser, Gmail, Calendar, etc.) follow the normal
            risk-based rules.
          </p>
          <p className="mb-0 text-zinc-600">
            Trust rules for skill tools are version-bound: they record the skill&apos;s
            content hash. If the skill&apos;s source files change, the hash changes and
            you&apos;re re-prompted. Modified skills can&apos;t silently inherit previous
            approvals.
          </p>
        </section>

        <section id="macos-system-permissions" className="mt-12">
          <SectionHeading id="macos-system-permissions" level={2}>
            macOS system permissions
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            On top of the assistant&apos;s own permission system, macOS has its own layer:
          </p>
          <div className="mb-4 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-zinc-50">
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    Permission
                  </th>
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    What it unlocks
                  </th>
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    Where to grant it
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50">
                <tr>
                  <td className="px-3 py-2">
                    <strong>Accessibility</strong>
                  </td>
                  <td className="px-3 py-2">
                    Controlling mouse and keyboard
                  </td>
                  <td className="px-3 py-2">
                    System Settings &gt; Privacy &amp; Security &gt; Accessibility
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    <strong>Screen Recording</strong>
                  </td>
                  <td className="px-3 py-2">
                    Seeing your screen content
                  </td>
                  <td className="px-3 py-2">
                    System Settings &gt; Privacy &amp; Security &gt; Screen Recording
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    <strong>Microphone</strong>
                  </td>
                  <td className="px-3 py-2">
                    Voice input
                  </td>
                  <td className="px-3 py-2">
                    System Settings &gt; Privacy &amp; Security &gt; Microphone
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mb-0 text-zinc-600">
            These are the &ldquo;can it access this at all&rdquo; layer. The
            assistant&apos;s Allow/Deny prompts are the &ldquo;should it access
            this right now&rdquo; layer. Both must pass for an action to execute.
          </p>
        </section>

        <section id="cross-channel-approvals" className="mt-12">
          <SectionHeading id="cross-channel-approvals" level={2}>
            Cross-channel approvals
          </SectionHeading>
          <p className="mb-3 text-zinc-600">
            When someone messages your assistant through Telegram or Slack and the
            assistant needs to do something that requires permission, it routes the
            approval request to you (the guardian) through your active channel.
          </p>
          <p className="mb-3 text-zinc-600">Approval grants are:</p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>One-time use</strong>: a grant is consumed when the action executes
              and can&apos;t be reused
            </li>
            <li>
              <strong>Time-limited</strong>: grants expire after 5 minutes if not used
            </li>
            <li>
              <strong>Scoped</strong>: bound to the specific tool and input that was
              requested
            </li>
          </ul>
          <p className="mb-0 text-zinc-600">
            Guardian approvals are always downgraded to one-time grants: they never
            create persistent trust rules. To create a rule that auto-approves future
            actions, you&apos;d need to do that directly from the desktop app.
          </p>
        </section>

        <section id="what-happens-when-you-say-no" className="mt-12">
          <SectionHeading id="what-happens-when-you-say-no" level={2}>
            What happens when you say no
          </SectionHeading>
          <p className="mb-3 text-zinc-600">When you deny an action:</p>
          <ol className="mb-4 list-decimal space-y-2 pl-6 text-zinc-600">
            <li>The action is blocked immediately</li>
            <li>Your assistant acknowledges the denial</li>
            <li>It does <strong>not</strong> retry automatically</li>
            <li>It asks if there&apos;s an alternative approach</li>
            <li>It only retries with your explicit consent</li>
          </ol>
          <p className="mb-0 text-zinc-600">
            If you create a deny rule for a pattern, future attempts to use that tool with
            a matching pattern are blocked silently: the assistant won&apos;t even ask.
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
