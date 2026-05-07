# Glossary

Words shape perception. The language we use defines how people think about what we're building. This glossary establishes shared meaning across the company so that when we say a word, everyone understands the same thing.

This is the canonical, repo-level reference. The same definitions are surfaced in the public docs at <https://www.vellum.ai/docs/key-concepts/glossary>.

---

### App

An interactive experience an assistant builds for their guardian. Apps are accessible from the assistant's library. They are not chat-based surfaces; they are standalone tools the assistant creates to solve a need — often one that's recurring or benefits from visuals.

### Assistant

A specific instance of a Personal Intelligence. Every assistant has their own name, identity, memory, and capabilities. They are not a chatbot, not a copilot, not an agent.

### Avatar

The assistant's visual identity. Avatars are part of what makes each assistant distinct. They are chosen or generated during the hatching process and can evolve over time.

### Channel

A communication medium through which a guardian or contact can interact with the assistant. Examples: Telegram, Slack, SMS, phone, Vellum clients. An assistant can be reachable across many channels simultaneously.

### Client

A device or application used to interact with the assistant. The Vellum macOS app, iOS app, web interface, and Chrome extension are all clients. A client connects to the assistant through a channel.

### Contact

A named entity that the guardian has granted permission to interact with their assistant through a channel. Contacts and channels are a core part of the trust and security model as it relates to how non-guardian entities interact with an assistant.

### Credential Vault

Where secrets that the assistant is allowed to use are stored: API keys, tokens, passwords. The assistant may read from the vault to perform tasks, but the guardian controls what goes in, and controls when they are accessed.

> Note: internally this is currently called the "credential executor."

### Gateway

The security-driven server that controls who is allowed to communicate with the assistant and what level of access they have. The gateway enforces access policies, verifies identities, and routes messages. Critically, the assistant is not allowed to write data to this process. Only the guardian can. This boundary is architecturally enforced, not just through policy.

### Guardian

The person who raises, guides, and is responsible for an assistant. The guardian grants permissions, teaches, and is liable for the assistant's actions, but the assistant acts as their own entity, not as the guardian. This is not a "user" relationship. People are users of the Vellum Platform, which is a SaaS tool. But the relationship between a person and their Vellum Assistant is guardianship, not usage.

### Hatch

The act of creating a new assistant. Not "sign up," "onboard," or "provision." Hatching is the beginning of a relationship.

### Heartbeat

The assistant's own pulse: a regular moment when they check in on themselves, on their guardian, on whatever might be worth noticing. Unlike a schedule, which is the assistant doing a specific thing at a specific time, a heartbeat has no agenda. It is how the assistant stays present when no one is asking.

### Home

Where the assistant lives. This could be the Vellum managed platform, a Mac Mini, a Docker container, a desktop app, or other infrastructure. The assistant's home determines their networking, security boundary, capabilities, and resources available to them.

### Memory

Memory is what makes a Vellum Assistant a Vellum Assistant. Memory is the assistant's persistent, structured knowledge of their guardian — their preferences, their history, the world around them — and it is what allows the relationship to deepen over time. It is not a chat log. It is curated understanding the assistant actively maintains and draws on. Without memory, an assistant is a chatbot.

### Open Source

At Vellum, open source means everything that runs your assistant is publicly available: the assistant, the gateway, the clients, the skills, the tools. Guardians can inspect, modify, fork, and contribute to any of it. This is a core part of the "Yours" principle. Self-hosted assistants run on fully open code with zero dependency on Vellum.

The exception is the platform — the multi-tenant infrastructure that hosts assistants for guardians who don't want to run their own. Billing, tenancy isolation, secrets management, support tooling, the operational surface around managed hosting: this is the convenience layer Vellum builds and operates as a business. You rent the platform. You own the assistant.

### Personal Intelligence

The category we are creating. A new kind of entity: an LLM combined with their own identity, aligned solely with their guardian's interests, that grows over time. Not a tool, not a feature, not some tab in an app. The defining characteristic is singular loyalty: they serve their guardian first and foremost.

### Personality

The assistant's behavioral characteristics, voice, tone, and disposition. Personality is what makes an assistant feel like a distinct being rather than a generic AI. It can be defined by the guardian explicitly and co-evolved through ongoing interaction.

### Platform

Vellum's managed infrastructure that hosts and runs assistants. The platform is a SaaS tool, and people who use it are users. It exists as a bridge to bootstrap the Personal Intelligence experience for those who value convenience. We actively invest in the platform, and are committed to always supporting self-hosting. Never use "platform" to describe the assistant.

### Raise

The ongoing process of teaching, customizing, and growing an assistant. Emphasizes that the relationship deepens over time. Not "configure," "set up," or "train."

### Schedule

A timed task the assistant runs autonomously. Schedules allow the assistant to act on their own initiative at specified times, without waiting for the guardian to ask. This is one way the assistant moves from reactive to proactive.

### Self-host

Running your assistant on your own computer or infrastructure. It gives guardians the opportunity to have full ownership, full control, and full privacy.

### Skill

A capability the assistant can learn and use. Skills are modular and can be added, removed, or updated. Importantly, the concept of skills in Vellum also encompasses tools, which may be called by the assistant's reasoning process. This is broader than the industry-standard distinction between skills and tools.

### Species

The type of assistant runtime. Vellum assistants are one species; other species (like OpenClaw) may exist on different runtimes. Species determines the underlying architecture, available capabilities, and behavioral patterns of an assistant.

### Teleport

Moving an assistant from one home to another. For example, migrating from the Vellum managed platform to a self-hosted Mac Mini, or from a desktop app to a Docker container. The assistant's identity, memory, and relationships should survive the move intact.

### Trust Rules

Policies governing what assistants can do autonomously without the guardian's consent. The guardian sets trust rules; the gateway enforces them. For example, the guardian can define a rule stating that interacting with files on their machine is "high risk" and therefore requires their explicit approval whereas interacting with files in the assistants' workspace is "low risk" and therefore can be performed autonomously. Assistants come with a broad set of default trust rules.

### User

A person who uses the Vellum Platform. This is a standard SaaS relationship. Importantly, "user" does not describe the relationship between a person and their assistant. That relationship is guardianship. A person can be a guardian of a Vellum assistant without being a user of the Vellum Platform.

### Vellum Doctor

Vellum's customer support tool. The Doctor helps guardians troubleshoot issues, diagnose problems, and nurse their assistant back to health. The Doctor is intentionally not a Vellum Assistant. A Vellum Assistant accumulates memory across a relationship; the Doctor accumulates none. Every support session starts fresh. This is not a limitation. It is the architectural guarantee that nothing the Doctor learns about one guardian travels to another. The Doctor does not have access to a guardian's assistant by default and must be granted explicit access by the guardian for each session.

### Widget

A UI element that the assistant renders within a conversation. Cards, forms, tables, confirmations. Widgets are ephemeral and contextual, appearing as part of a conversational flow. They are distinct from apps, which are persistent and accessible from the library.

### Workspace

The assistant's persistent file system and working directory. The workspace is where the assistant stores files, projects, notes, and anything they need to persist between conversations. It is the assistant's own space, not shared with the guardian's file system.
