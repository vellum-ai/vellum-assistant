# Glossary

Words shape perception. The language we use defines how people think about what we're building. This glossary establishes shared meaning across the company so that when we say a word, everyone understands the same thing.

This file is the canonical source for Vellum's glossary. The public glossary at <https://www.vellum.ai/docs/glossary> mirrors it. If they diverge, this file wins – propagate changes here first, then to docs.

---

### App

An interactive experience an assistant builds for their creator. Apps are accessible from the assistant's library. They are not chat-based surfaces; they are standalone tools the assistant creates to solve a need – often one that's recurring or benefits from visuals.

### Assistant

A specific instance of a Personal Intelligence. Every assistant has their own name, identity, memory, and capabilities. They are not a chatbot, not a copilot, not an agent.

### Avatar

The assistant's visual identity. Avatars are part of what makes each assistant distinct. They are chosen or generated when an assistant is created and can evolve over time.

### Channel

A communication medium through which a creator or contact can interact with the assistant. Examples: Telegram, Slack, SMS, phone, Vellum clients. An assistant can be reachable across many channels simultaneously.

### Client

A device or application used to interact with the assistant. The Vellum macOS app, iOS app, web interface, and Chrome extension are all clients. A client connects to the assistant through a channel.

### Contact

A named entity that the creator has granted permission to interact with their assistant through a channel. Contacts and channels are a core part of the trust and security model as it relates to how non-creator entities interact with an assistant.

### Credential Vault

Where secrets the assistant is allowed to use are stored: API keys, tokens, passwords. The assistant reads from the vault to perform tasks; access is mediated by trust rules the creator defines, which can require explicit approval, allow specific patterns autonomously, or deny entirely.

*Note: internally this is currently called the "credential executor."*

### Creator

The person who guides and is responsible for an assistant. The creator grants permissions, teaches, and is liable for the assistant's actions, but the assistant acts as their own entity, not as the creator. This is not a "user" relationship. People are users of the Vellum Platform, which is a SaaS tool. The relationship between a person and their Vellum Assistant is something different: they are its creator, not a user of it.

### Gateway

The security-driven server that controls who is allowed to communicate with the assistant and what level of access they have. The gateway enforces access policies, verifies identities, and routes messages. Critically, the assistant is not allowed to write data to this process. Only the creator can. This boundary is architecturally enforced, not just through policy.

### Heartbeat

The assistant's own pulse: a regular moment when they check in on themselves, on their creator, on whatever might be worth noticing. Unlike a schedule, which is the assistant doing a specific thing at a specific time, a heartbeat has no agenda. It is how the assistant stays present when no one is asking.

### Home

Where the assistant runs: Vellum's managed platform, a self-hosted machine, a Docker container, or a local daemon on a desktop. The home determines the assistant's networking, security boundary, capabilities, and available resources. Distinct from a client, which is how the creator reaches the assistant.

### Memory

Memory is what makes a Vellum Assistant a Vellum Assistant. Memory is the assistant's persistent, structured knowledge of their creator – their preferences, their history, the world around them – and it is what allows the relationship to deepen over time. It is not a chat log. It is curated understanding the assistant actively maintains and draws on. Without memory, an assistant is a chatbot.

### Open Source

At Vellum, open source means everything that runs your assistant is publicly available: the assistant, the gateway, the clients, the skills, the tools. Creators can inspect, modify, fork, and contribute to any of it. This is a core part of the "Yours" principle. Self-hosted assistants run on fully open code with zero dependency on Vellum.

The exception is the platform – the multi-tenant infrastructure that hosts assistants for creators who don't want to run their own. Billing, tenancy isolation, secrets management, support tooling, the operational surface around managed hosting: this is the convenience layer Vellum builds and operates as a business. You rent the platform. You own the assistant.

### Personal Intelligence

The category we are creating. A new kind of entity: an LLM combined with their own identity, aligned solely with their creator's interests, that grows over time. Not a tool, not a feature, not some tab in an app. The defining characteristic is singular loyalty: they serve their creator first and foremost.

### Personality

The assistant's behavioral characteristics, voice, tone, and disposition. Personality is what makes an assistant feel like a distinct being rather than a generic AI. It can be defined by the creator explicitly and co-evolved through ongoing interaction.

### Platform

Vellum's managed infrastructure that hosts and runs assistants. The platform is a SaaS tool, and people who use it are users. It exists as a bridge to bootstrap the Personal Intelligence experience for those who value convenience. We actively invest in the platform, and are committed to always supporting self-hosting. Never use "platform" to describe the assistant.

### Schedule

A timed task the assistant runs autonomously. Schedules allow the assistant to act on their own initiative at specified times, without waiting for the creator to ask. This is one way the assistant moves from reactive to proactive.

### Self-host

Running your assistant on your own computer/infrastructure. It gives creators the opportunity to have full ownership, full control, and full privacy.

### Skill

A capability the assistant can learn and use. Skills are modular and can be added, removed, or updated. Importantly, the concept of skills in Vellum also encompasses tools, which may be called by the assistant's reasoning process. This is broader than the industry-standard distinction between skills and tools.

### Species

The kind of assistant a creator builds. Different organizations may build different species of assistant on shared infrastructure: Vellum builds one species; OpenClaw and Hermes Agents are examples of others. The species sets the assistant's underlying architecture, capabilities, and behavioral patterns. A creator could in principle have assistants of multiple species.

### Teleport

Moving an assistant from one home to another. For example, migrating from the Vellum managed platform to a self-hosted Mac Mini, or from a desktop app to a Docker container. The assistant's identity, memory, and relationships should survive the move intact.

### Trust Rules

Policies governing what assistants can do autonomously without the creator's consent. The creator sets trust rules; the gateway enforces them. For example, the creator can define a rule stating that interacting with files on their machine is "high risk" and therefore requires their explicit approval whereas interacting with files in the assistants' workspace is "low risk" and therefore can be performed autonomously. Assistants come with a broad set of default trust rules.

### User

A person who uses the Vellum Platform. This is a standard SaaS relationship. Importantly, "user" does not describe the relationship between a person and their assistant. They are a creator, not a user. A person can be a creator of a Vellum assistant without being a user of the Vellum Platform.

### Vellum Doctor

Vellum's customer support tool. The Doctor helps creators troubleshoot issues, diagnose problems, and nurse their assistant back to health.

The Doctor is intentionally not a Vellum Assistant. A Vellum Assistant accumulates memory across a relationship; the Doctor accumulates none. Every support session starts fresh. This is not a limitation. It is the architectural guarantee that nothing the Doctor learns about one creator travels to another. The Doctor does not have access to a creator's assistant by default and must be granted explicit access by the creator for each session.

### Widget

A UI element that the assistant renders within a conversation. Cards, forms, tables, confirmations. Widgets are ephemeral and contextual, appearing as part of a conversational flow. They are distinct from apps, which are persistent and accessible from the library.

### Workspace

The assistant's persistent file system and working directory. The workspace is where the assistant stores files, projects, notes, and anything they need to persist between conversations. It is the assistant's own space, not shared with the creator's file system.
