"use client";

import {
  Brain,
  FileText,
  Info,
  Key,
  MessageSquare,
  Settings,
  Shield,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode } from "react";

import { routes } from "@/lib/routes";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  {
    id: "what-lives-in-your-assistants-workspace",
    label: "What lives in your assistant's workspace",
    level: 2,
  },
  {
    id: "what-leaves-your-assistant",
    label: "What leaves your assistant",
    level: 2,
  },
  {
    id: "how-credentials-are-protected",
    label: "How credentials are protected",
    level: 2,
  },
  { id: "how-secrets-are-caught", label: "How secrets are caught", level: 2 },
  {
    id: "who-can-access-your-data",
    label: "Who can access your data",
    level: 2,
  },
  { id: "private-conversations", label: "Private conversations", level: 2 },
  { id: "computer-use-safety", label: "Computer use safety", level: 2 },
  { id: "the-permission-system", label: "The permission system", level: 2 },
  { id: "the-ai-model-provider", label: "The AI model provider", level: 2 },
  {
    id: "your-options-for-sensitive-information",
    label: "Your options for sensitive information",
    level: 2,
  },
  { id: "hosting-options", label: "Hosting options", level: 2 },
];

/* ── Sub-components ──────────────────────────────────────────────────── */

interface PrivacyCardProps {
  tier: "secure" | "context";
  icon: LucideIcon;
  title: string;
  description?: string;
  path: string;
  detail?: string;
}

function PrivacyCard({
  tier,
  icon: Icon,
  title,
  description,
  path,
  detail,
}: PrivacyCardProps) {
  return (
    <div className={`privacy-card privacy-card--${tier}`}>
      <div className="privacy-card-header">
        <Icon
          size={18}
          className={`privacy-card-icon privacy-card-icon--${tier}`}
        />
        <div>
          <div className="privacy-card-title">{title}</div>
          {description && (
            <div className="privacy-card-desc">{description}</div>
          )}
        </div>
      </div>
      <code className="privacy-card-path">{path}</code>
      {detail && <div className="privacy-card-detail">{detail}</div>}
    </div>
  );
}

function Callout({ children }: { children: ReactNode }) {
  return (
    <div className="privacy-callout">
      <Info size={18} className="privacy-callout-icon" />
      <div>{children}</div>
    </div>
  );
}

/* ── Page content ────────────────────────────────────────────────────── */

export function TrustSecurityPrivacyDataContent() {
  return (
    <>
      <DocsContent
        title="Privacy & Data"
        breadcrumb="Docs / Trust & Security / Privacy & Data"
      >
        <p className="mb-4 text-zinc-600">
          Your assistant&apos;s data lives wherever your assistant is hosted.
          On Vellum Cloud (the default), your data lives in your private,
          encrypted Vellum Cloud account. If you self-host on your Mac,
          everything stays on your machine.
        </p>
        <p className="mb-8 text-zinc-600">
          Regardless of hosting option, your assistant thinks through an AI
          model in the cloud. Here&apos;s exactly what that means.
        </p>

        {/* ── What lives in your assistant's workspace ─────────────── */}

        <section id="what-lives-in-your-assistants-workspace">
          <SectionHeading
            id="what-lives-in-your-assistants-workspace"
            level={2}
          >
            What lives in your assistant&apos;s workspace
          </SectionHeading>

          <p className="mb-4 text-zinc-600">
            All of the following data stays within your assistant&apos;s
            environment and never leaves it, except where noted. On Vellum
            Cloud this means your private cloud account; on self-hosted
            installations this means your machine.
          </p>

          {/* Tier: never leaves */}
          <div className="mb-8">
            <div className="privacy-tier-heading">
              Never leaves your assistant
            </div>
            <div className="privacy-grid">
              <PrivacyCard
                tier="secure"
                icon={Key}
                title="Credentials"
                description="API keys, OAuth tokens"
                path="Credential Execution Service"
                detail="Isolated container (Cloud) or process (desktop). Never exposed to the assistant or AI model."
              />
              <PrivacyCard
                tier="secure"
                icon={Shield}
                title="Trust rules & permissions"
                path="Gateway-managed store"
                detail="Owned by the gateway, never sent to the assistant or AI model"
              />
              <PrivacyCard
                tier="secure"
                icon={Sparkles}
                title="Custom skills"
                path="skills/ in your workspace"
              />
              <PrivacyCard
                tier="secure"
                icon={Settings}
                title="Configuration"
                path="config.json in your workspace"
              />
            </div>
          </div>

          {/* Tier: AI model context */}
          <div className="mb-4">
            <div className="privacy-tier-heading">
              Included in AI model calls when relevant
            </div>
            <div className="privacy-grid">
              <PrivacyCard
                tier="context"
                icon={FileText}
                title="Workspace files"
                description="IDENTITY.md, SOUL.md, USER.md, NOW.md, PKB"
                path="Workspace root"
                detail="Loaded at the start of each conversation as context"
              />
              <PrivacyCard
                tier="context"
                icon={Brain}
                title="Memories"
                description="Events, knowledge, feelings, plans, patterns, stories"
                path="Long-term memory store"
                detail="Retrieved via hybrid search when relevant to a conversation"
              />
              <PrivacyCard
                tier="context"
                icon={MessageSquare}
                title="Conversation history"
                description="Messages, tool calls, results"
                path="conversations/ in your workspace"
                detail="Current conversation only, compacted when long"
              />
            </div>
          </div>
        </section>

        {/* ── What leaves your assistant ───────────────────────────── */}

        <section id="what-leaves-your-assistant" className="mt-12">
          <SectionHeading id="what-leaves-your-assistant" level={2}>
            What leaves your assistant
          </SectionHeading>

          <p className="mb-4 text-zinc-600">
            Data leaves your assistant&apos;s environment in two ways:
          </p>

          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>AI model calls</strong>: conversation context (messages,
              workspace files, relevant memories) is sent to the AI model
              provider for inference. Currently, this is Anthropic (Claude)
              with a zero-retention data policy.
            </li>
            <li>
              <strong>Channel messages</strong>: when your assistant sends
              a message through Telegram, Slack, email, or phone, that
              message content passes through the respective
              platform&apos;s servers. If you&apos;ve enabled the
              assistant&apos;s own email address (the optional{" "}
              <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
                email-channel
              </code>{" "}
              feature, currently backed by AgentMail), outbound mail from
              that address also passes through the AgentMail provider.
            </li>
            <li>
              <strong>Tool network calls</strong>: when a tool makes an
              external API request (e.g., web search, fetching a URL), that
              request leaves your environment. Credentials for these requests
              are injected by a proxy at the network layer: the assistant
              never sees the raw credential values.
            </li>
          </ul>

          <Callout>
            On Vellum Cloud (the default), your data is stored in
            Vellum&apos;s infrastructure, isolated in a dedicated, encrypted
            container, and accessible to Vellum only for operational purposes.
            If you self-host and opt out of usage analytics, your workspace
            files, memories, conversation history, credentials, and trust
            rules are never sent to Vellum, and the only external party that
            receives conversation context is the AI model provider. The
            exception in both cases is the <strong>Share Feedback</strong>{" "}
            feature, which explicitly sends logs when you choose to use it.
          </Callout>
        </section>

        {/* ── How credentials are protected ────────────────────────── */}

        <section id="how-credentials-are-protected" className="mt-12">
          <SectionHeading id="how-credentials-are-protected" level={2}>
            How credentials are protected
          </SectionHeading>

          <p className="mb-4 text-zinc-600">
            Credentials (API keys, OAuth tokens, passwords) are handled by
            the <strong>Credential Execution Service (CES)</strong>, an
            isolated component that runs alongside your assistant. The
            assistant talks to CES over a controlled RPC interface but
            never sees the credential values themselves.
          </p>

          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Isolation</strong>: on Vellum Cloud, CES runs in a
              dedicated container with its own private storage that the
              assistant container literally cannot read. On desktop, CES
              runs as a separate process with its own sandboxed data
              directory under your Vellum root. Same architectural
              property in both cases: the assistant and the AI model
              never touch raw secrets.
            </li>
            <li>
              <strong>Storage</strong>: credentials are encrypted at rest.
              The encryption key itself is held by CES, not by the
              assistant.
            </li>
            <li>
              <strong>Network injection</strong>: when a tool needs to
              make an authenticated API call, the credential proxy
              injects the token into the outbound HTTP request at the
              network layer. The assistant only knows which credential
              to use (by alias), not what it contains.
            </li>
            <li>
              <strong>Secure collection</strong>: the{" "}
              <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
                credential_store
              </code>{" "}
              tool collects secrets through a dedicated UI prompt.
              Secret values never enter the conversation text.
            </li>
          </ul>
        </section>

        {/* ── How secrets are caught ───────────────────────────────── */}

        <section id="how-secrets-are-caught" className="mt-12">
          <SectionHeading id="how-secrets-are-caught" level={2}>
            How secrets are caught
          </SectionHeading>

          <p className="mb-4 text-zinc-600">
            Even with secure collection, secrets can accidentally end up in
            conversation text: pasted from a clipboard, included in a file,
            or returned in a tool output. A multi-layer detection pipeline
            catches these:
          </p>

          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Ingress scanning</strong>: inbound messages are checked
              for known secret patterns before they reach the assistant.
              Detected secrets are blocked or redacted.
            </li>
            <li>
              <strong>Pattern matching</strong>: regex-based detectors for
              common secret formats: API keys, tokens, connection strings,
              private keys, and more.
            </li>
            <li>
              <strong>Allowlist</strong>: known false positives can be
              allowlisted so they don&apos;t trigger the scanner.
            </li>
            <li>
              <strong>Tool output scanning</strong>: secrets in tool
              execution results are detected and handled before they enter
              the conversation context.
            </li>
          </ul>

          <Callout>
            The secret scanner is a safety net, not a guarantee. The primary
            defense is the credential architecture: secrets are collected
            securely and injected at the network layer, so they should never
            appear in conversation text in the first place.
          </Callout>
        </section>

        {/* ── Who can access your data ─────────────────────────────── */}

        <section id="who-can-access-your-data" className="mt-12">
          <SectionHeading id="who-can-access-your-data" level={2}>
            Who can access your data
          </SectionHeading>

          <p className="mb-4 text-zinc-600">
            Your assistant distinguishes between three levels of access:
          </p>

          <ul className="mb-4 list-disc space-y-4 pl-6 text-zinc-600">
            <li>
              <strong>Guardian (you)</strong>: full access to everything,
              memories, workspace files, credentials, tools,
              configuration. Your guardian identity is tied to your
              authenticated session, whether that&apos;s the web app or
              the desktop app, and verified automatically.
            </li>
            <li>
              <strong>Trusted contacts</strong>: verified people who message
              your assistant through external channels (Telegram, Slack,
              email). They can have conversations and use allowed
              tools, but they can&apos;t access your memories, read your
              workspace files, or use sensitive tools without guardian approval.
            </li>
            <li>
              <strong>Unknown contacts</strong>: unverified users who reach
              your assistant on a channel. They go through a
              channel-appropriate challenge before being granted any
              access (an invite code on Telegram, Slack, and email; an
              outbound voice verification on phone).
            </li>
          </ul>
        </section>

        {/* ── Private conversations ────────────────────────────────── */}

        <section id="private-conversations" className="mt-12">
          <SectionHeading id="private-conversations" level={2}>
            Private conversations
          </SectionHeading>

          <p className="mb-0 text-zinc-600">
            A private conversation has its own isolated memory scope. Memories
            created during a private conversation can&apos;t leak into other
            conversations. The private conversation can still read from your
            shared memory pool, but anything it saves stays scoped to that
            conversation. Useful when discussing sensitive topics you
            don&apos;t want persisted broadly.
          </p>
        </section>

        {/* ── Computer use safety ──────────────────────────────────── */}

        <section id="computer-use-safety" className="mt-12">
          <SectionHeading id="computer-use-safety" level={2}>
            Computer use safety
          </SectionHeading>

          <p className="mb-4 text-zinc-600">
            When your assistant controls your Mac through computer use, it
            follows a structured perceive &rarr; verify &rarr; execute &rarr;
            observe loop:
          </p>

          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>Screenshots are captured and analyzed to understand the current state</li>
            <li>Each action (click, type, key press, drag, AppleScript) is a separate tool call with its own risk assessment</li>
            <li>Before interacting, the assistant verifies it&apos;s looking at the right element</li>
            <li>After each action, it observes the result before continuing</li>
          </ul>

          <p className="mb-0 text-zinc-600">
            Computer use tools are classified as medium or high risk, meaning
            they prompt for your approval. You can create persistent trust
            rules for common workflows (e.g., &ldquo;always allow clicking in
            VS Code&rdquo;) to reduce friction while maintaining control.
          </p>
        </section>

        {/* ── The permission system ────────────────────────────────── */}

        <section id="the-permission-system" className="mt-12">
          <SectionHeading id="the-permission-system" level={2}>
            The permission system
          </SectionHeading>

          <p className="mb-4 text-zinc-600">
            Every tool has a risk classification:
          </p>

          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Low risk</strong>: runs automatically. Reading files,
              searching memory, generating text.
            </li>
            <li>
              <strong>Medium risk</strong>: prompts for approval. Writing
              files, running shell commands, sending messages.
            </li>
            <li>
              <strong>High risk</strong>: always prompts. Deleting data,
              modifying system settings, computer use actions.
            </li>
          </ul>

          <p className="mb-4 text-zinc-600">
            When a tool prompts for approval, you can:
          </p>

          <ul className="mb-4 list-disc space-y-1 pl-6 text-zinc-600">
            <li>Allow (creates a trust rule for similar future actions)</li>
            <li>Allow &amp; Create Rule (customize the rule in the Rule Editor)</li>
            <li>Deny</li>
          </ul>

          <p className="mb-0 text-zinc-600">
            Trust rules are stored in a gateway-managed database and accumulate
            over time as you use your assistant. Each rule has a tool, pattern,
            risk level, scope, and decision. You can review and manage rules in
            Settings &gt; Permissions &amp; Privacy. On external channels where
            there&apos;s no native prompt UI, approvals are handled through
            interactive buttons (Telegram, Slack) or the guardian system.
          </p>
        </section>

        {/* ── The AI model provider ────────────────────────────────── */}

        <section id="the-ai-model-provider" className="mt-12">
          <SectionHeading id="the-ai-model-provider" level={2}>
            The AI model provider
          </SectionHeading>

          <p className="mb-4 text-zinc-600">
            Your assistant uses a third-party AI model to generate
            responses. By default, data is routed to{" "}
            <strong>Anthropic</strong> (Claude) using Vellum&apos;s
            credentials. If you connect your own API key, you can switch
            to <strong>OpenAI</strong>, <strong>Google</strong> (Gemini),{" "}
            <strong>OpenRouter</strong>, or <strong>Fireworks</strong>. If
            you want to keep model inference fully local, you can also
            point your assistant at a local <strong>Ollama</strong>{" "}
            instance instead of a hosted provider. Under the published
            terms of these providers&apos; commercial APIs, your inputs
            are not used to train or improve their models, and are not
            used for advertising.
          </p>

          <p className="mb-4 text-zinc-600">
            What gets sent to the model on each turn:
          </p>

          <ul className="mb-4 list-disc space-y-1 pl-6 text-zinc-600">
            <li>The system prompt (assembled from your workspace files)</li>
            <li>Conversation history (current conversation, possibly compacted)</li>
            <li>Relevant memories (retrieved via hybrid search)</li>
            <li>Tool definitions (available tools and their schemas)</li>
            <li>Tool results (output from recently executed tools)</li>
          </ul>

          <p className="mb-4 text-zinc-600">
            Credentials, trust rules, and raw configuration files are never
            included in model calls.
          </p>

          <p className="mb-0 text-zinc-600">
            For the complete list of providers, what data each feature shares,
            and links to each provider&apos;s privacy notice, see the
            &ldquo;Third-Party AI Providers&rdquo; section of our{" "}
            <a href={routes.docs.legal.privacyPolicy}>Privacy Notice</a>.
          </p>
        </section>

        {/* ── Your options for sensitive information ────────────────── */}

        <section id="your-options-for-sensitive-information" className="mt-12">
          <SectionHeading
            id="your-options-for-sensitive-information"
            level={2}
          >
            Your options for sensitive information
          </SectionHeading>

          <ul className="mb-0 list-disc space-y-4 pl-6 text-zinc-600">
            <li>
              <strong>Use private conversations</strong>: memory from
              private conversations is scoped and won&apos;t leak into future
              contexts.
            </li>
            <li>
              <strong>Never paste secrets in chat</strong>: use{" "}
              <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
                credential_store
              </code>{" "}
              with the secure prompt action instead. The value never enters
              the conversation.
            </li>
            <li>
              <strong>Review workspace files</strong>: check USER.md and
              SOUL.md periodically. If something sensitive got saved there,
              remove it. These files are sent to the model on every
              conversation.
            </li>
            <li>
              <strong>Manage memories</strong>: ask your assistant to delete
              specific memories, or review them with &ldquo;show me what you
              remember about X.&rdquo; You have full control over what stays
              in memory.
            </li>
            <li>
              <strong>Scope trust rules carefully</strong>: avoid
              broad &ldquo;always allow&rdquo; rules for high-risk tools. Use
              conversation-scoped or time-limited approvals instead.
            </li>
          </ul>
        </section>

        {/* ── Hosting options ──────────────────────────────────────── */}

        <section id="hosting-options" className="mt-12">
          <SectionHeading id="hosting-options" level={2}>
            Hosting options
          </SectionHeading>

          <div className="mb-8">
            <h4 className="mb-2 font-semibold text-zinc-900">
              Vellum Cloud (recommended)
            </h4>
            <p className="mb-0 text-zinc-600">
              Your assistant runs in Vellum&apos;s cloud infrastructure. Your
              data is isolated in a dedicated, encrypted container that is
              not shared with other users. You get 24/7 uptime, automatic
              updates, and no local machine dependency. Schedules, watchers,
              and heartbeats run reliably even when your desktop is off.
            </p>
          </div>

          <div>
            <h4 className="mb-2 font-semibold text-zinc-900">
              Self-Hosted (Local)
            </h4>
            <p className="mb-0 text-zinc-600">
              Your assistant runs on your Mac. All data stays local.
              Conversations, memories, workspace files, credentials: none of
              it leaves your device except for AI model inference and outbound
              channel messages. You manage updates, uptime, and backups.
            </p>
          </div>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
