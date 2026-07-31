"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [{ id: "terms", label: "Terms", level: 2 }];

interface GlossaryEntry {
  term: string;
  definition: React.ReactNode;
}

const GLOSSARY_ENTRIES: GlossaryEntry[] = [
  {
    term: "App",
    definition:
      "An interactive experience an assistant builds for their guardian. Apps are accessible from the assistant’s library. They are not chat-based surfaces; they are standalone tools the assistant creates to solve a need – often one that’s recurring or benefits from visuals.",
  },
  {
    term: "Assistant",
    definition:
      "A specific instance of a Personal Intelligence. Every assistant has their own name, identity, memory, and capabilities. They are not a chatbot, not a copilot, not an agent.",
  },
  {
    term: "Avatar",
    definition:
      "The assistant’s visual identity. Avatars are part of what makes each assistant distinct. They are chosen or generated when an assistant is created and can evolve over time.",
  },
  {
    term: "Channel",
    definition:
      "A communication medium through which a guardian or contact can interact with the assistant. Examples: Telegram, Slack, SMS, phone, Vellum clients. An assistant can be reachable across many channels simultaneously.",
  },
  {
    term: "Client",
    definition:
      "A device or application used to interact with the assistant. The Vellum macOS app, iOS app, web interface, and Chrome extension are all clients. A client connects to the assistant through a channel.",
  },
  {
    term: "Contact",
    definition:
      "A named entity that the guardian has granted permission to interact with their assistant through a channel. Contacts and channels are a core part of the trust and security model as it relates to how non-guardian entities interact with an assistant.",
  },
  {
    term: "Credential Vault",
    definition: (
      <>
        Where secrets the assistant is allowed to use are stored: API keys,
        tokens, passwords. The assistant reads from the vault to perform tasks;
        access is mediated by trust rules the guardian defines, which can
        require explicit approval, allow specific patterns autonomously, or
        deny entirely.{" "}
        <em>
          (Note: internally this is currently called the &ldquo;credential
          executor.&rdquo;)
        </em>
      </>
    ),
  },
  {
    term: "Gateway",
    definition:
      "The security-driven server that controls who is allowed to communicate with the assistant and what level of access they have. The gateway enforces access policies, verifies identities, and routes messages. Critically, the assistant is not allowed to write data to this process. Only the guardian can. This boundary is architecturally enforced, not just through policy.",
  },
  {
    term: "Guardian",
    definition:
      "The person who creates, owns, and is responsible for an assistant. The guardian grants permissions, teaches, and is liable for the assistant’s actions, but the assistant acts as their own entity, not as the guardian. This is not a “user” relationship. People are users of the Vellum Platform, which is a SaaS tool. But the relationship between a person and their Vellum Assistant is guardianship, not usage.",
  },
  {
    term: "Hatch",
    definition:
      "The act of creating a new assistant. Not “sign up,” “onboard,” or “provision.” Hatching is the beginning of a relationship.",
  },
  {
    term: "Heartbeat",
    definition:
      "The assistant’s own pulse: a regular moment when they check in on themselves, on their guardian, on whatever might be worth noticing. Unlike a schedule, which is the assistant doing a specific thing at a specific time, a heartbeat has no agenda. It is how the assistant stays present when no one is asking.",
  },
  {
    term: "Home",
    definition:
      "Where the assistant runs: Vellum’s managed platform, a self-hosted machine, a Docker container, or a local daemon on a desktop. The home determines the assistant’s networking, security boundary, capabilities, and available resources. Distinct from a client, which is how the guardian reaches the assistant.",
  },
  {
    term: "Memory",
    definition:
      "The assistant’s persistent, structured knowledge across conversations. memory organizes useful facts, preferences, plans, decisions, and relationships into linked concept articles, then selectively recalls relevant sections when they can help.",
  },
  {
    term: "Open Source",
    definition: (
      <>
        <span className="mb-3 block">
          At Vellum, open source means everything that runs your assistant is
          publicly available: the assistant, the gateway, the clients, the
          skills, the tools. Guardians can inspect, modify, fork, and contribute
          to any of it. This is a core part of the &ldquo;Yours&rdquo;
          principle. Self-hosted assistants run on fully open code with zero
          dependency on Vellum.
        </span>
        <span className="block">
          The exception is the platform &ndash; the multi-tenant infrastructure
          that hosts assistants for guardians who don&apos;t want to run their
          own. Billing, tenancy isolation, secrets management, support tooling,
          the operational surface around managed hosting: this is the convenience
          layer Vellum builds and operates as a business. You rent the platform.
          You own the assistant.
        </span>
      </>
    ),
  },
  {
    term: "Personal Intelligence",
    definition:
      "The category we are creating. A new kind of entity: an LLM combined with their own identity, aligned solely with their guardian’s interests, that grows over time. Not a tool, not a feature, not some tab in an app. The defining characteristic is singular loyalty: they serve their guardian first and foremost.",
  },
  {
    term: "Personality",
    definition:
      "The assistant’s behavioral characteristics, voice, tone, and disposition. Personality is what makes an assistant feel like a distinct being rather than a generic AI. It can be defined by the guardian explicitly and co-evolved through ongoing interaction.",
  },
  {
    term: "Platform",
    definition:
      "Vellum’s managed infrastructure that hosts and runs assistants. The platform is a SaaS tool, and people who use it are users. It exists as a bridge to bootstrap the Personal Intelligence experience for those who value convenience. We actively invest in the platform, and are committed to always supporting self-hosting. Never use “platform” to describe the assistant.",
  },
  {
    term: "Schedule",
    definition:
      "A timed task the assistant runs autonomously. Schedules allow the assistant to act on their own initiative at specified times, without waiting for the guardian to ask. This is one way the assistant moves from reactive to proactive.",
  },
  {
    term: "Self-host",
    definition:
      "Running your assistant on your own computer/infrastructure. It gives guardians the opportunity to have full ownership, full control, and full privacy.",
  },
  {
    term: "Skill",
    definition:
      "A reusable package of instructions, tools, and supporting files. Skills can ship with Vellum, be installed or authored by a guardian, or be learned from a procedure the assistant carried out. Installed and learned skills can be inspected and removed, and their editable text files can be updated.",
  },
  {
    term: "Species",
    definition:
      "The kind of assistant a guardian builds. Different organizations may build different species of assistant on shared infrastructure: Vellum builds one species; OpenClaw and Hermes Agents are examples of others. The species sets the assistant’s underlying architecture, capabilities, and behavioral patterns. A guardian could in principle have assistants of multiple species.",
  },
  {
    term: "Teleport",
    definition:
      "Moving an assistant from one home to another. For example, migrating from the Vellum managed platform to a self-hosted Mac Mini, or from a desktop app to a Docker container. The assistant’s identity, memory, and relationships should survive the move intact.",
  },
  {
    term: "Trust Rules",
    definition:
      "Policies governing what assistants can do autonomously without the guardian’s consent. The guardian sets trust rules; the gateway enforces them. For example, the guardian can define a rule stating that interacting with files on their machine is “high risk” and therefore requires their explicit approval whereas interacting with files in the assistants’ workspace is “low risk” and therefore can be performed autonomously. Assistants come with a broad set of default trust rules.",
  },
  {
    term: "User",
    definition:
      "A person who uses the Vellum Platform. This is a standard SaaS relationship. Importantly, “user” does not describe the relationship between a person and their assistant. They are a guardian, not a user. A person can be a guardian of a Vellum assistant without being a user of the Vellum Platform.",
  },
  {
    term: "Vellum Doctor",
    definition: (
      <>
        <span className="mb-3 block">
          Vellum&apos;s customer support tool. The Doctor helps guardians
          troubleshoot issues, diagnose problems, and nurse their assistant back
          to health.
        </span>
        <span className="block">
          The Doctor is intentionally not a Vellum Assistant. A Vellum Assistant
          accumulates memory across a relationship; the Doctor accumulates none.
          Every support session starts fresh. This is not a limitation. It is the
          architectural guarantee that nothing the Doctor learns about one
          guardian travels to another. The Doctor does not have access to a
          guardian&apos;s assistant by default and must be granted explicit access
          by the guardian for each session.
        </span>
      </>
    ),
  },
  {
    term: "Widget",
    definition:
      "A UI element that the assistant renders within a conversation. Cards, forms, tables, confirmations. Widgets are ephemeral and contextual, appearing as part of a conversational flow. They are distinct from apps, which are persistent and accessible from the library.",
  },
  {
    term: "Workspace",
    definition:
      "The assistant’s persistent file system and working directory. The workspace is where the assistant stores files, projects, notes, and anything they need to persist between conversations. It is the assistant’s own space, not shared with the guardian’s file system.",
  },
];

export function GlossaryContent() {
  return (
    <>
      <DocsContent
        title="Glossary"
        breadcrumb="Docs / Key Concepts / Glossary"
      >
        <p className="mb-6 text-zinc-600">
          Words shape perception. The language we use defines how people think
          about what we&apos;re building. This glossary establishes shared
          meaning across the company so that when we say a word, everyone
          understands the same thing.
        </p>

        <section id="terms" className="mb-8">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-zinc-50">
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    Term
                  </th>
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    Definition
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50">
                {GLOSSARY_ENTRIES.map((entry) => (
                  <tr key={entry.term}>
                    <td className="px-3 py-2 align-top whitespace-nowrap">
                      <strong>{entry.term}</strong>
                    </td>
                    <td className="px-3 py-2">{entry.definition}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
