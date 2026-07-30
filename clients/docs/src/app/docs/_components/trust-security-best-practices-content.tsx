"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "be-intentional-about-what-you-share", label: "Be intentional about what you share", level: 2 },
  { id: "review-your-workspace-and-trust-rules", label: "Review your workspace and trust rules", level: 2 },
  { id: "understand-what-youre-approving", label: "Understand what you're approving", level: 2 },
  { id: "be-cautious-with-custom-skills", label: "Be cautious with custom skills", level: 2 },
  { id: "credential-hygiene", label: "Credential hygiene", level: 2 },
  { id: "computer-use-safety", label: "Computer use safety", level: 2 },
  { id: "channel-security", label: "Channel security", level: 2 },
  { id: "network-awareness", label: "Network awareness", level: 2 },
  { id: "starting-over", label: "Starting over", level: 2 },
];

export function TrustSecurityBestPracticesContent() {
  return (
    <>
      <DocsContent
        title="Security Best Practices"
        breadcrumb="Docs / Trust & Security / Security Best Practices"
      >
        <p className="mb-8 text-zinc-600">
          Your assistant is a powerful tool. Powerful tools deserve thoughtful use.
          Here are practical tips for getting the most out of Vellum while staying
          safe.
        </p>

        <section id="be-intentional-about-what-you-share">
          <SectionHeading id="be-intentional-about-what-you-share" level={2}>
            Be intentional about what you share
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Your assistant remembers what you tell it. Facts and preferences are
            extracted automatically and stored as memories. Those memories may
            be included in future AI model calls when they&apos;re relevant.
          </p>
          <p className="mb-4 text-zinc-600">
            Share freely for things that help your assistant help you: projects,
            preferences, schedule patterns, how you like to work.
          </p>
          <p className="mb-4 text-zinc-600">
            Think twice before sharing highly sensitive information like
            passwords, financial account details, medical records, or legal
            matters. If it&apos;s in the conversation, it may end up in a memory
            and in future model calls.
          </p>
          <p className="mb-3 text-zinc-600">If you shared something sensitive:</p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              Ask it to forget: &ldquo;Forget what I told you about [topic]&rdquo;
            </li>
            <li>
              Use a private conversation for sensitive topics: memories stay isolated
              and won&apos;t surface in other conversations
            </li>
            <li>
              Edit USER.md directly to remove anything you don&apos;t want persisted
            </li>
          </ul>
          <p className="mb-0 text-zinc-600">
            Your assistant does run a secret scanner that catches accidentally shared
            credentials (API keys, tokens, passwords in common formats), but
            don&apos;t rely on it as your only protection. It&apos;s a safety net, not
            a strategy.
          </p>
        </section>

        <section id="review-your-workspace-and-trust-rules" className="mt-12">
          <SectionHeading id="review-your-workspace-and-trust-rules" level={2}>
            Review your workspace and trust rules
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Your assistant&apos;s state lives in files you can read. Take advantage
            of that.
          </p>
          <p className="mb-3 text-zinc-600">
            Every few weeks, open your workspace files and glance through.
            On the web, that&apos;s <strong>About your assistant &gt; Workspace</strong>.
            On desktop with a local install, you can also browse{" "}
            <code>~/.vellum/workspace/</code> directly.
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>USER.md</strong>: Is everything accurate? Anything you&apos;d
              rather remove?
            </li>
            <li>
              <strong>SOUL.md</strong>: Are the behavior rules still what you want?
            </li>
            <li>
              <strong>IDENTITY.md</strong>: Still happy with the name and
              personality?
            </li>
          </ul>
          <p className="mb-0 text-zinc-600">
            Also review your trust rules in Settings &gt; Permissions &amp; Privacy.
            These are the accumulated allow and deny rules that control what your
            assistant can do without asking. Over time, you may have approved things
            broadly that you&apos;d rather scope more narrowly.
          </p>
        </section>

        <section id="understand-what-youre-approving" className="mt-12">
          <SectionHeading id="understand-what-youre-approving" level={2}>
            Understand what you&apos;re approving
          </SectionHeading>
          <p className="mb-3 text-zinc-600">When a permission prompt appears:</p>
          <ol className="mb-4 list-decimal space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Read it.</strong> Don&apos;t click Allow out of habit.
            </li>
            <li>
              <strong>Check the scope.</strong> Is it reading one file or your entire
              home directory?
            </li>
            <li>
              <strong>Look at the risk level.</strong> Low, medium, and high risk
              actions have different implications.
            </li>
            <li>
              <strong>Consider the context.</strong> Does this action make sense for
              what you just asked?
            </li>
            <li>
              <strong>Consider the scope.</strong> Clicking Allow creates a trust
              rule for similar future actions. If you want more control over the
              pattern, use &ldquo;Allow &amp; Create Rule&rdquo; to customize it
              in the Rule Editor before saving.
            </li>
            <li>
              <strong>Say no if unsure.</strong> Your assistant won&apos;t retry
              automatically. It&apos;ll ask about alternative approaches.
            </li>
          </ol>
          <blockquote className="mb-0 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-zinc-700">
            <strong>Autopilot warning:</strong> It&apos;s easy to start clicking Allow
            reflexively after your first dozen prompts. Each prompt is a new action.
            Take the half-second to read it.
          </blockquote>
        </section>

        <section id="be-cautious-with-custom-skills" className="mt-12">
          <SectionHeading id="be-cautious-with-custom-skills" level={2}>
            Be cautious with custom skills
          </SectionHeading>
          <p className="mb-3 text-zinc-600">
            Custom skills can read files, run commands, and make network requests.
            Treat them like any software you install.
          </p>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Review the code.</strong> If your assistant wrote a custom skill,
              ask to see it before saving: &ldquo;Show me what this skill does.&rdquo;
            </li>
            <li>
              <strong>Know the safety rails.</strong> Third-party skill tools are
              always prompted by default, regardless of risk level. Writing to skill
              source files is classified as high-risk. These protections exist because
              a malicious skill could escalate its own privileges.
            </li>
            <li>
              <strong>Review community skills before installing.</strong> If you
              install a skill from the clawhub registry, read the SKILL.md and tool
              definitions first. Skills are audited, but you should verify yourself.
            </li>
            <li>
              <strong>Test before trusting.</strong> Run a new skill a few times with
              one-time approvals before creating persistent trust rules for
              its tools.
            </li>
          </ul>
        </section>

        <section id="credential-hygiene" className="mt-12">
          <SectionHeading id="credential-hygiene" level={2}>
            Credential hygiene
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Your credentials are isolated behind a{" "}
            <strong>Credential Execution Service</strong> (CES), a separate
            process that handles authentication so the assistant itself
            never sees credential values in plaintext. On Vellum Cloud,
            CES runs in its own isolated container with private storage.
            On a local install, credentials live in an encrypted file
            under your assistant&apos;s protected directory, sealed with
            a key the assistant container can&apos;t read.
          </p>
          <p className="mb-3 text-zinc-600">Even so:</p>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Use scoped tokens.</strong> When connecting services, grant the
              minimum access needed. Read-only when possible.
            </li>
            <li>
              <strong>Rotate periodically.</strong> If you&apos;ve stored API keys,
              consider rotating them every few months.
            </li>
            <li>
              <strong>Revoke what you don&apos;t use.</strong> Ask &ldquo;Show me my
              credentials&rdquo; and clean up anything stale.
            </li>
            <li>
              <strong>Don&apos;t store master passwords.</strong> The credential vault
              is for service tokens and API keys, not your primary account passwords.
            </li>
          </ul>
        </section>

        <section id="computer-use-safety" className="mt-12">
          <SectionHeading id="computer-use-safety" level={2}>
            Computer use safety
          </SectionHeading>
          <p className="mb-3 text-zinc-600">
            When your assistant controls your screen:
          </p>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Watch the overlay.</strong> It shows what the assistant is doing
              at each step. Each action is prompted individually.
            </li>
            <li>
              <strong>You can stop at any time.</strong> Cancel the session if
              something doesn&apos;t look right.
            </li>
            <li>
              <strong>Be mindful of what&apos;s on screen.</strong> The assistant
              captures screenshots and reads the accessibility tree. If sensitive
              information is visible (banking, medical records, private messages), it
              will be included in the model call.
            </li>
            <li>
              <strong>Know the limits.</strong> Sessions are capped at 50 steps. Loop
              detection pauses the assistant if it gets stuck. Destructive keyboard
              shortcuts are blocked.
            </li>
          </ul>
        </section>

        <section id="channel-security" className="mt-12">
          <SectionHeading id="channel-security" level={2}>
            Channel security
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Your assistant can communicate through multiple channels: Telegram, Slack,
            phone calls, and more. Every channel is protected by the same verification
            system.
          </p>
          <p className="mb-3 text-zinc-600">
            <strong>Guardian verification.</strong> When you first set up
            a new channel, you must complete a verification handshake.
            Your assistant displays a six-digit code in your authenticated
            session (web or desktop) and you provide that code in the new
            channel. Only after this handshake will your assistant talk to
            you on that channel.
          </p>
          <p className="mb-3 text-zinc-600">
            <strong>Trusted contacts.</strong> If someone else tries to contact your
            assistant (e.g., calls its phone number), you get a notification: &ldquo;This
            number called me. Do you want to add them as a trusted contact?&rdquo; If
            you approve, they receive their own six-digit code and must complete the
            same verification. Trusted contacts can talk to the AI, but they cannot
            perform sensitive actions without your explicit approval through
            guardian-in-the-loop notifications.
          </p>
          <p className="mb-3 text-zinc-600">
            <strong>Strangers are hard-denied.</strong> Anyone who hasn&apos;t been
            verified gets a deterministic response: &ldquo;Sorry, I don&apos;t have
            permission to talk to you.&rdquo; This message is not generated by the AI.
            It&apos;s a hard-coded response that cannot be prompt-injected past.
          </p>
          <p className="mb-3 text-zinc-600">
            <strong>Guardian-in-the-loop.</strong> When a trusted contact asks your
            assistant to do something that requires a tool call or sensitive action, you
            (the guardian) receive a notification and must approve the action before it
            executes. This keeps the guardian in control even when others are chatting
            with your assistant.
          </p>
          <p className="mb-0 text-zinc-600">
            <strong>Cross-channel approvals are one-time.</strong> When someone triggers
            an action through Telegram that needs your approval, the grant is consumed on
            use and expires after 5 minutes. It can&apos;t be reused.
          </p>
        </section>

        <section id="network-awareness" className="mt-12">
          <SectionHeading id="network-awareness" level={2}>
            Network awareness
          </SectionHeading>
          <p className="mb-3 text-zinc-600">
            Your assistant makes network calls in two situations:
          </p>
          <ol className="mb-4 list-decimal space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>AI model calls</strong>: your messages and context
              go to the model provider over HTTPS. By default that&apos;s
              Anthropic (Claude); with your own API key you can switch
              to OpenAI, Google (Gemini), OpenRouter, or Fireworks, or
              point at a local Ollama instance for fully on-device
              inference.
            </li>
            <li>
              <strong>Service API calls</strong>: emails, calendar events, web
              browsing, etc. over HTTPS
            </li>
          </ol>
          <p className="mb-0 text-zinc-600">
            If you&apos;re on a sensitive network (corporate VPN, public WiFi), be
            aware that these calls are happening. They&apos;re encrypted in transit,
            but the data is still traversing the network.
          </p>
        </section>

        <section id="starting-over" className="mt-12">
          <SectionHeading id="starting-over" level={2}>
            Starting over
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            If you want to completely reset, the path depends on where
            your assistant lives.
          </p>

          <h3 className="mb-2 mt-6 text-lg font-semibold text-zinc-800">
            On Vellum Cloud
          </h3>
          <ol className="mb-4 list-decimal space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Reset your workspace</strong> from the web app to
              clear identity, memory, and conversations while keeping
              your Vellum account.
            </li>
            <li>
              <strong>Or delete the assistant entirely</strong> from
              account settings. The assistant container and its
              workspace are removed; the credential service tears down
              its isolated storage with it.
            </li>
            <li>
              <strong>Revoke OAuth connections</strong> at each
              connected service (Google, Slack, etc.) and remove the
              Vellum app on their side too.
            </li>
          </ol>

          <h3 className="mb-2 mt-6 text-lg font-semibold text-zinc-800">
            On a local install
          </h3>
          <ol className="mb-4 list-decimal space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Archive your workspace:</strong> Run{" "}
              <code>vellum retire</code> from the CLI. This creates a
              tarball backup of your workspace before removing it.
            </li>
            <li>
              <strong>Or delete manually:</strong> Remove{" "}
              <code>~/.vellum/</code> entirely. Your assistant starts
              from scratch.
            </li>
            <li>
              <strong>Revoke macOS permissions:</strong> System Settings
              &gt; Privacy &amp; Security &gt; remove Vellum from
              Accessibility, Screen Recording, and Microphone.
            </li>
            <li>
              <strong>Revoke OAuth connections</strong> at each
              connected service and remove the Vellum app on their side.
            </li>
          </ol>

          <p className="mb-0 text-zinc-600">
            Either way, this is irreversible (unless you archived
            first). Everything your assistant has learned is gone. But
            it&apos;s your data and your choice.
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
