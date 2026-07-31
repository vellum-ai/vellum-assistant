"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "sandbox", label: "Sandbox", level: 2 },
  { id: "sandbox-troubleshooting", label: "Troubleshooting", level: 3 },
  { id: "credentials", label: "Credentials", level: 2 },
  { id: "credential-references", label: "Credential References", level: 3 },
  { id: "wildcard-matching", label: "Wildcard Matching", level: 3 },
  { id: "ambiguity-blocking", label: "Ambiguity Blocking", level: 3 },
  { id: "debugging-401s", label: "Debugging 401 Errors", level: 3 },
  { id: "risk-tolerance", label: "Risk Tolerance", level: 2 },
  { id: "trust-rules", label: "Trust Rules", level: 2 },
  { id: "shell-allowlists", label: "Shell Command Allowlists", level: 3 },
  { id: "skill-approvals", label: "Version-bound Skill Approvals", level: 3 },
  { id: "skill-mutation-protection", label: "Skill Mutation Protection", level: 3 },
];

export function DeveloperGuideSecurityContent() {
  return (
    <>
      <DocsContent title="Security & Permissions" breadcrumb="Docs / Developer Guide / Security">
        <p className="mb-8 text-zinc-600">
          Vellum uses OS-level sandboxing, a keychain-backed credential vault, and a scoped trust rule system to keep
          your data safe while giving the assistant the access it needs.
        </p>

        {/* Sandbox */}
        <section id="sandbox">
          <SectionHeading id="sandbox" level={2}>
            Sandbox
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            The sandbox uses native OS-level sandboxing: <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-sm dark:bg-zinc-800">sandbox-exec</code> with
            SBPL profiles on macOS, <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-sm dark:bg-zinc-800">bwrap</code> (bubblewrap) on Linux.
            No extra dependencies on macOS. <strong>Fail-closed</strong>: if the backend is unavailable, commands fail immediately rather than
            falling back to unsandboxed execution.
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li><strong>Workspace tools</strong> (<code className="text-sm">file_read</code>, <code className="text-sm">file_write</code>, <code className="text-sm">file_edit</code>, <code className="text-sm">bash</code>) operate within <code className="text-sm">~/.vellum/workspace</code>.</li>
            <li><strong>Host tools</strong> (<code className="text-sm">host_bash</code>, <code className="text-sm">host_file_read</code>, <code className="text-sm">host_file_write</code>, <code className="text-sm">host_file_edit</code>) execute directly on the host, subject to trust rules and permission prompts.</li>
          </ul>

          <section id="sandbox-troubleshooting" className="mt-6">
            <SectionHeading id="sandbox-troubleshooting" level={3}>
              Troubleshooting
            </SectionHeading>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 dark:border-zinc-700">
                    <th className="py-2 pr-4 text-left font-medium text-zinc-900 dark:text-zinc-100">Symptom</th>
                    <th className="py-2 pr-4 text-left font-medium text-zinc-900 dark:text-zinc-100">Cause</th>
                    <th className="py-2 text-left font-medium text-zinc-900 dark:text-zinc-100">Fix</th>
                  </tr>
                </thead>
                <tbody className="text-zinc-600 dark:text-zinc-400">
                  <tr className="border-b border-zinc-100 dark:border-zinc-800">
                    <td className="py-2 pr-4"><code className="text-xs">Docker CLI is not installed</code></td>
                    <td className="py-2 pr-4">Docker not installed</td>
                    <td className="py-2">Install Docker Desktop</td>
                  </tr>
                  <tr className="border-b border-zinc-100 dark:border-zinc-800">
                    <td className="py-2 pr-4"><code className="text-xs">Docker daemon is not running</code></td>
                    <td className="py-2 pr-4">Docker Desktop not started</td>
                    <td className="py-2">Start Docker Desktop or <code className="text-xs">sudo systemctl start docker</code></td>
                  </tr>
                  <tr className="border-b border-zinc-100 dark:border-zinc-800">
                    <td className="py-2 pr-4"><code className="text-xs">Cannot bind-mount the sandbox root</code></td>
                    <td className="py-2 pr-4">File sharing not configured</td>
                    <td className="py-2">Add <code className="text-xs">~/.vellum/workspace</code> to Docker file sharing</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4"><code className="text-xs">bwrap cannot create namespaces</code></td>
                    <td className="py-2 pr-4">bubblewrap not installed (Linux)</td>
                    <td className="py-2"><code className="text-xs">apt install bubblewrap</code></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="mt-4 text-sm text-zinc-500">
              Run <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs dark:bg-zinc-800">vellum doctor</code> for a full diagnostic check.
            </p>
          </section>
        </section>

        {/* Credentials */}
        <section id="credentials" className="mt-12">
          <SectionHeading id="credentials" level={2}>
            Credentials
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Secrets are stored in the macOS Keychain (encrypted file fallback on Linux). The LLM never sees raw tokens or keys.
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li><strong>Secret prompt</strong>: a floating <code className="text-sm">SecureField</code> panel collects credentials; the LLM never sees the value.</li>
            <li><strong>Ingress blocking</strong>: inbound messages are scanned for secrets (regex + entropy) and rejected if detected.</li>
            <li><strong>Usage policy</strong>: each credential specifies <code className="text-sm">allowedTools</code> and <code className="text-sm">allowedDomains</code>, enforced by the <code className="text-sm">CredentialBroker</code>.</li>
            <li><strong>No plaintext read API</strong>: secrets are only consumed by the broker for scoped tool execution.</li>
            <li><strong>One-time send</strong>: when enabled, a &ldquo;Send Once&rdquo; button lets users provide a value for immediate use without persisting it.</li>
          </ul>

          <section id="credential-references" className="mt-6">
            <SectionHeading id="credential-references" level={3}>
              Credential References
            </SectionHeading>
            <p className="mb-4 text-zinc-600">
              Use either format in proxied shell commands:
            </p>
            <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
              <li><strong>UUID</strong>: the canonical credential ID from <code className="text-sm">credential_store list</code></li>
              <li><strong>service/field</strong>: human-readable, e.g. <code className="text-sm">fal/api_key</code></li>
            </ul>
            <p className="mb-4 text-zinc-600">Unknown references fail immediately with a clear error before the command executes.</p>
          </section>

          <section id="wildcard-matching" className="mt-6">
            <SectionHeading id="wildcard-matching" level={3}>
              Wildcard Matching
            </SectionHeading>
            <p className="mb-4 text-zinc-600">
              Patterns like <code className="text-sm">*.fal.run</code> match subdomains (<code className="text-sm">api.fal.run</code>, <code className="text-sm">queue.fal.run</code>)
              and the bare domain (<code className="text-sm">fal.run</code>). Exact patterns take precedence over wildcards.
            </p>
          </section>

          <section id="ambiguity-blocking" className="mt-6">
            <SectionHeading id="ambiguity-blocking" level={3}>
              Ambiguity Blocking
            </SectionHeading>
            <p className="mb-4 text-zinc-600">
              When multiple credentials match the same host, the request is blocked: the proxy refuses to guess.
              Per-credential selection picks the most specific template (exact &gt; wildcard). Cross-credential resolution
              blocks when more than one credential matches.
            </p>
          </section>

          <section id="debugging-401s" className="mt-6">
            <SectionHeading id="debugging-401s" level={3}>
              Debugging 401 Errors
            </SectionHeading>
            <ol className="mb-4 list-decimal space-y-2 pl-6 text-zinc-600">
              <li>Check the credential reference matches via <code className="text-sm">credential_store list</code></li>
              <li>Verify the <code className="text-sm">hostPattern</code> matches the target host</li>
              <li>Check for ambiguity: overlapping patterns block injection</li>
              <li>Verify the injection template has the correct <code className="text-sm">headerName</code> and <code className="text-sm">valuePrefix</code></li>
              <li>Enable <code className="text-sm">LOG_LEVEL=debug</code> for decision traces</li>
            </ol>
          </section>
        </section>

        {/* Risk Tolerance */}
        <section id="risk-tolerance" className="mt-12">
          <SectionHeading id="risk-tolerance" level={2}>
            Risk Tolerance
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            The <code className="text-sm">autoApproveUpTo</code> threshold controls which risk levels auto-approve
            without prompting. Configured per execution context via the gateway.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-700">
                  <th className="py-2 pr-4 text-left font-medium text-zinc-900 dark:text-zinc-100">Threshold</th>
                  <th className="py-2 pr-4 text-left font-medium text-zinc-900 dark:text-zinc-100">UI Label</th>
                  <th className="py-2 text-left font-medium text-zinc-900 dark:text-zinc-100">Behavior</th>
                </tr>
              </thead>
              <tbody className="text-zinc-600 dark:text-zinc-400">
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><code className="text-sm">none</code></td>
                  <td className="py-2 pr-4">Strict</td>
                  <td className="py-2">Prompt for every action. No auto-approve.</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><code className="text-sm">low</code></td>
                  <td className="py-2 pr-4">Default</td>
                  <td className="py-2">Auto-approve Low risk. Prompt for Medium and High.</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><code className="text-sm">medium</code></td>
                  <td className="py-2 pr-4">Relaxed</td>
                  <td className="py-2">Auto-approve Low and Medium risk. Prompt for High only.</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4"><code className="text-sm">high</code></td>
                  <td className="py-2 pr-4">Full access</td>
                  <td className="py-2">Auto-approve all risk levels. No prompts.</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-4 mb-4 text-zinc-600">
            Accepts a scalar string applied to all contexts, or an object with per-context overrides:
          </p>
          <pre className="overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
{`// Scalar: same threshold everywhere
autoApproveUpTo: "low"

// Per-context: different thresholds per execution context
autoApproveUpTo: {
  conversation: "low",    // interactive chat sessions
  background: "medium",   // scheduled tasks, heartbeats
  headless: "none"        // API/webhook-triggered (strictest)
}`}
          </pre>
        </section>

        {/* Trust Rules */}
        <section id="trust-rules" className="mt-12">
          <SectionHeading id="trust-rules" level={2}>
            Trust Rules
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Trust rules are persisted in a SQLite database managed by the gateway process. Each rule stores a tool name,
            glob pattern, risk level, decision (allow/deny/ask), and optional directory scope.
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li><strong>Pattern matching</strong>: glob patterns for commands, file paths, and URLs</li>
            <li><strong>Directory scoping</strong>: rules can be scoped to a specific directory, project root, or everywhere. Resolved filesystem paths are matched at evaluation time.</li>
            <li><strong>Priority resolution</strong>: deny beats ask beats allow at equal priority. More specific patterns win over broader ones.</li>
          </ul>

          <section id="shell-allowlists" className="mt-6">
            <SectionHeading id="shell-allowlists" level={3}>
              Shell Command Allowlists
            </SectionHeading>
            <p className="mb-4 text-zinc-600">
              When you approve a shell command, the prompt offers parser-derived allowlist options based on the command&apos;s structure.
              For example, <code className="text-sm">cd /repo &amp;&amp; gh pr view 5525 --json title</code> generates:
            </p>
            <ul className="mb-4 list-disc space-y-1 pl-6 text-zinc-600">
              <li><code className="text-sm">cd /repo &amp;&amp; gh pr view 5525 --json title</code>: exact command</li>
              <li><code className="text-sm">gh pr view *</code>: any <code className="text-sm">gh pr view</code> command</li>
              <li><code className="text-sm">gh pr *</code>: any <code className="text-sm">gh pr</code> command</li>
              <li><code className="text-sm">gh *</code>: any <code className="text-sm">gh</code> command</li>
            </ul>
            <p className="mb-4 text-zinc-600">
              Compound commands with multiple non-prefix actions only offer an exact-command option to prevent over-generalization.
            </p>
          </section>

          <section id="skill-approvals" className="mt-6">
            <SectionHeading id="skill-approvals" level={3}>
              Version-bound Skill Approvals
            </SectionHeading>
            <p className="mb-4 text-zinc-600">
              Trust rules record the skill&apos;s version hash. If source files change, the hash changes and you&apos;re re-prompted:
              modified skills can&apos;t silently inherit previous approvals.
            </p>
          </section>

          <section id="skill-mutation-protection" className="mt-6">
            <SectionHeading id="skill-mutation-protection" level={3}>
              Skill Mutation Protection
            </SectionHeading>
            <p className="mb-4 text-zinc-600">
              Writes to skill directories are escalated to <strong>high risk</strong>, preventing the agent from modifying its own
              capabilities without explicit consent.
            </p>
          </section>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
