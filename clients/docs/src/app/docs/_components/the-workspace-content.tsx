"use client";

import Image from "next/image";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "whats-in-there", label: "What's in there", level: 2 },
  { id: "the-core-files", label: "The core files", level: 2 },
  { id: "identity-md", label: "IDENTITY.md", level: 3 },
  { id: "soul-md", label: "SOUL.md", level: 3 },
  { id: "user-md", label: "USER.md", level: 3 },
  { id: "now-md", label: "NOW.md", level: 3 },
  { id: "avatar", label: "Avatar", level: 2 },
  { id: "files-you-might-see-briefly", label: "Files you might see briefly", level: 2 },
  { id: "bootstrap-md", label: "BOOTSTRAP.md", level: 3 },
  { id: "updates-md", label: "UPDATES.md", level: 3 },
  { id: "conversations", label: "Conversations", level: 2 },
  { id: "the-skills-directory", label: "The skills/ directory", level: 2 },
  { id: "knowledge-base", label: "Knowledge base", level: 2 },
  { id: "scratch", label: "Scratch space", level: 2 },
  { id: "the-data-directory", label: "The data/ directory", level: 2 },
  { id: "the-protected-directory", label: "Credentials and secrets", level: 2 },
  { id: "the-sandbox", label: "The sandbox", level: 2 },
  { id: "why-this-matters", label: "Why this matters", level: 2 },
];

export function TheWorkspaceContent() {
  return (
    <>
      <DocsContent title="The Workspace" breadcrumb="Docs / Key Concepts / The Workspace">
        <p className="mb-4 text-zinc-600">
          Your assistant&apos;s identity, personality, and knowledge about you
          live in its workspace, a set of plain text files you can open, read,
          and edit.
        </p>
        <p className="mb-4 text-zinc-600">
          On <strong>Vellum Cloud</strong>, your workspace is encrypted and
          isolated to your account. You browse and edit it through the web
          app. There&apos;s no folder on your computer to worry about.
        </p>
        <p className="mb-8 text-zinc-600">
          On the <strong>desktop app with local hosting</strong>, the same
          workspace lives in a folder on your machine at{" "}
          <code>~/.vellum/workspace/</code>, where you can also open it in any
          text editor. The structure and the files are the same in both
          places.
        </p>

        <div className="mb-12 overflow-hidden rounded-xl border border-stone-200 bg-white dark:border-moss-600/50 dark:bg-moss-700">
          <Image
            src="/docs/docs-workspace-files.webp"
            alt="The Workspace tab on the About your assistant screen, showing the file tree on the left and IDENTITY.md open in preview on the right"
            width={3590}
            height={2100}
            unoptimized
            className="w-full"
          />
        </div>

        <section id="whats-in-there">
          <SectionHeading id="whats-in-there" level={2}>
            What&apos;s in there
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Whether your workspace lives in Vellum Cloud or on your local
            machine, the structure is the same. The tree below shows the
            local layout; on Cloud, you see the same files in the web app.
          </p>
          <div className="mb-6 overflow-x-auto rounded-xl border border-zinc-200 bg-zinc-950 p-4">
            <pre className="font-[family-name:var(--font-dm-mono)] text-sm text-zinc-100">
{`workspace/
├── IDENTITY.md            ← Who your assistant is
├── SOUL.md                ← How your assistant behaves
├── USER.md                ← What it knows about you
├── NOW.md                 ← Working scratchpad (tasks, context, goals)
├── config.json            ← Runtime configuration
├── conversations/         ← Per-conversation folders with attachments
├── skills/                ← Installed and custom skills
├── pkb/                   ← Knowledge base (notes about you and your work)
├── scratch/               ← Working files, exports, generated assets
└── data/                  ← Internal state
    ├── db/                ← Conversation history (SQLite)
    ├── qdrant/            ← Memory embeddings (vector DB)
    ├── apps/              ← User-built apps
    ├── avatar/            ← Avatar image
    └── logs/              ← Assistant logs`}
            </pre>
          </div>
          <p className="mb-0 text-zinc-600">
            Credentials and secrets are kept in a separate, isolated store
            (the credential vault on Cloud, or <code>~/.vellum/protected/</code>{" "}
            on local). They&apos;re never included in workspace exports or
            diagnostic logs.
          </p>
        </section>

        <section id="the-core-files" className="mt-12">
          <SectionHeading id="the-core-files" level={2}>
            The core files
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            Three identity files are loaded into every conversation. When your
            assistant wakes up, it reads them to remember who it is, who you
            are, and how it should behave. Edit any of them, and the changes
            take effect on the next conversation.
          </p>

          <div id="identity-md" className="mb-10">
            <SectionHeading id="identity-md" level={3}>
              IDENTITY.md
            </SectionHeading>
            <p className="mb-4 text-zinc-600">
              Your assistant&apos;s self-definition:
            </p>
            <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
              <li>
                <strong>Name</strong>: what you called it (or what it
                named itself during onboarding)
              </li>
              <li>
                <strong>Emoji</strong>: its signature emoji, chosen
                during onboarding
              </li>
              <li>
                <strong>Nature</strong>: how it thinks of itself
              </li>
              <li>
                <strong>Personality</strong>: a short description of its
                vibe and conversational style
              </li>
              <li>
                <strong>Role</strong>: what it does for you
              </li>
            </ul>
            <div className="mb-4 overflow-x-auto rounded-xl border border-zinc-200 bg-zinc-50 p-4">
              <pre className="font-[family-name:var(--font-dm-mono)] text-sm text-zinc-900">
{`- Name: Bob
- Emoji: 😏
- Nature: AI familiar
- Personality: Witty, sharp, slightly irreverent
- Role: Personal assistant, second brain`}
              </pre>
            </div>
            <p className="mb-0 text-zinc-600">
              You can edit this file directly. Change the name, tweak the
              personality, swap the emoji. Your assistant picks up the changes
              next time you talk to it.
            </p>
          </div>

          <div id="soul-md" className="mb-10">
            <SectionHeading id="soul-md" level={3}>
              SOUL.md
            </SectionHeading>
            <p className="mb-4 text-zinc-600">
              The big one. SOUL.md is your assistant&apos;s constitution:
              the principles and behavioral rules it follows in every
              conversation.
            </p>
            <p className="mb-3 text-zinc-600">What&apos;s in here:</p>
            <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
              <li>
                <strong>Core principles</strong>: the fundamentals (be
                helpful, be resourceful, have opinions, earn trust)
              </li>
              <li>
                <strong>Communication style</strong>: how it talks to you
                (concise vs. detailed, casual vs. formal)
              </li>
              <li>
                <strong>Task approach</strong>: how it handles work
                (action over explanation, when to ask vs. just do)
              </li>
              <li>
                <strong>Boundaries</strong>: when to ask before acting,
                what lines not to cross
              </li>
            </ul>
            <p className="mb-0 text-zinc-600">
              Your assistant updates this file on its own as it learns what
              works for you. But you can edit it too. Want it to stop being
              sarcastic? Remove the sarcasm. Want it to always explain before
              acting? Add that rule. It&apos;s your file.
            </p>
          </div>

          <div id="user-md" className="mb-10">
            <SectionHeading id="user-md" level={3}>
              USER.md
            </SectionHeading>
            <p className="mb-4 text-zinc-600">
              Everything your assistant has learned about you:
            </p>
            <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
              <li>Your name and how you like to be addressed</li>
              <li>Your pronouns and locale</li>
              <li>Your work role and daily tools</li>
              <li>Projects you&apos;re working on</li>
              <li>Communication preferences</li>
              <li>Connected services and accounts</li>
            </ul>
            <p className="mb-0 text-zinc-600">
              Your assistant adds to this over time through conversations. You
              can also edit it directly to fast-track the learning process or
              correct something it got wrong. If you declined to answer a
              question during onboarding, it&apos;s marked here so the assistant
              doesn&apos;t re-ask.
            </p>
          </div>

          <div id="now-md">
            <SectionHeading id="now-md" level={3}>
              NOW.md
            </SectionHeading>
            <p className="mb-4 text-zinc-600">
              A working scratchpad for what&apos;s happening right now. Unlike
              the identity files, NOW.md is ephemeral: it tracks
              in-progress tasks, session context, goals, and anything the
              assistant needs to carry between conversations.
            </p>
            <p className="mb-0 text-zinc-600">
              The assistant reads and updates this file naturally as you work
              together. Think of it as a shared notepad: you can edit it
              too if you want to set priorities or leave context for the next
              session.
            </p>
          </div>
        </section>

        <section id="avatar" className="mt-12">
          <SectionHeading id="avatar" level={2}>
            Avatar
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Your assistant has a visual identity too. There are two layers:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Character avatar</strong>: the default. An
              SVG-based character composed from body shapes, eye styles,
              and colors, rendered as a PNG. This is what your assistant
              starts with.
            </li>
            <li>
              <strong>Custom avatar</strong>: you can set a custom
              image by uploading one, asking the assistant to generate one
              (it uses Gemini image generation), or dropping an image into
              the conversation. Custom images override the character
              avatar.
            </li>
          </ul>
          <p className="mb-0 text-zinc-600">
            Removing a custom avatar restores the character avatar
            automatically. The image lives in <code>data/avatar/</code>{" "}
            and the assistant manages it through dedicated tools (
            <code>set_avatar</code>, <code>remove_avatar</code>,{" "}
            <code>get_avatar</code>). You never need to touch
            files manually.
          </p>
        </section>

        <section id="files-you-might-see-briefly" className="mt-12">
          <SectionHeading id="files-you-might-see-briefly" level={2}>
            Files you might see briefly
          </SectionHeading>

          <div id="bootstrap-md" className="mb-10 mt-6">
            <SectionHeading id="bootstrap-md" level={3}>
              BOOTSTRAP.md
            </SectionHeading>
            <p className="mb-0 text-zinc-600">
              This file only exists during onboarding. It&apos;s the script your
              assistant follows for your first conversation: figuring out
              its name, its vibe, who you are, and what you need help with. Once
              onboarding is complete, the assistant deletes it. If you see it in
              your workspace, onboarding hasn&apos;t finished yet.
            </p>
          </div>

          <div id="updates-md">
            <SectionHeading id="updates-md" level={3}>
              UPDATES.md
            </SectionHeading>
            <p className="mb-0 text-zinc-600">
              When your assistant gets an update, release notes appear in this
              file. The assistant reads them, decides what&apos;s worth telling
              you about, and then deletes the file. You might catch it between
              updates, but it&apos;s not meant to stick around.
            </p>
          </div>
        </section>

        <section id="conversations" className="mt-12">
          <SectionHeading id="conversations" level={2}>
            Conversations
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Every conversation gets its own folder inside{" "}
            <code>conversations/</code>, named with a timestamp and unique ID.
            Each folder can contain attachments: files you sent to the
            assistant or that it generated during the conversation.
          </p>
          <p className="mb-0 text-zinc-600">
            The workspace is version-controlled as a git repository on both
            Cloud and local. Your assistant automatically commits changes
            after each conversation turn, so you get a full history of how
            your workspace evolved over time.
          </p>
        </section>

        <section id="the-skills-directory" className="mt-12">
          <SectionHeading id="the-skills-directory" level={2}>
            The skills/ directory
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Custom skills you&apos;ve built or installed from the community live
            here. Each skill gets its own folder. A minimal skill only needs one
            file:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>SKILL.md</strong>: instructions that teach the
              assistant when and how to use the skill
            </li>
          </ul>
          <p className="mb-4 text-zinc-600">
            More complex skills can also include:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>TOOLS.json</strong>: a manifest of what tools the
              skill provides
            </li>
            <li>
              <strong>tools/</strong>: the implementation code behind
              those tools
            </li>
          </ul>
          <p className="mb-0 text-zinc-600">
            Built-in skills from the catalog are loaded automatically and
            don&apos;t appear here. Only custom and community-installed
            skills show up in this directory. You can inspect, modify, or delete
            any of them.
          </p>
        </section>

        <section id="knowledge-base" className="mt-12">
          <SectionHeading id="knowledge-base" level={2}>
            Knowledge base
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            The <code>pkb/</code> directory is your assistant&apos;s personal
            knowledge base. It&apos;s a set of editable markdown files where
            your assistant keeps notes about you, your work, your projects,
            and anything else worth remembering across conversations.
          </p>
          <p className="mb-0 text-zinc-600">
            Unlike memory embeddings (which the assistant queries
            semantically in <code>data/qdrant/</code>), the knowledge base is
            human-readable. Open <code>pkb/INDEX.md</code> to see what&apos;s
            in there, and edit any file directly to correct or add to what
            your assistant knows.
          </p>
        </section>

        <section id="scratch" className="mt-12">
          <SectionHeading id="scratch" level={2}>
            Scratch space
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            The <code>scratch/</code> directory is a general-purpose working
            area. When the assistant generates images, exports files, writes
            scripts, or creates anything that isn&apos;t a conversation
            attachment, it lands here. Think of it as the assistant&apos;s
            desktop: a place for working files that don&apos;t belong
            anywhere specific.
          </p>
        </section>

        <section id="the-data-directory" className="mt-12">
          <SectionHeading id="the-data-directory" level={2}>
            The data/ directory
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            This is where the assistant keeps its internal state. You generally
            won&apos;t need to touch these, but here&apos;s what&apos;s in
            there:
          </p>
          <div className="mb-0 overflow-hidden rounded-xl border border-zinc-200">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-zinc-50">
                  <th className="px-4 py-3 text-left text-sm font-medium text-zinc-500">
                    Folder
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-zinc-500">
                    What it stores
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50">
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">db/</td>
                  <td className="px-4 py-3 text-zinc-600">
                    Conversation history, messages, and tool invocations (SQLite)
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">qdrant/</td>
                  <td className="px-4 py-3 text-zinc-600">
                    Memory embeddings powering the search system (vector DB)
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">apps/</td>
                  <td className="px-4 py-3 text-zinc-600">
                    Apps you&apos;ve asked the assistant to build
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">avatar/</td>
                  <td className="px-4 py-3 text-zinc-600">
                    Your assistant&apos;s avatar image
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">logs/</td>
                  <td className="px-4 py-3 text-zinc-600">
                    Assistant logs (useful for debugging)
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">browser-profile/</td>
                  <td className="px-4 py-3 text-zinc-600">
                    Headless browser session data
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">sounds/</td>
                  <td className="px-4 py-3 text-zinc-600">
                    Custom notification sounds
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section id="the-protected-directory" className="mt-12">
          <SectionHeading id="the-protected-directory" level={2}>
            Credentials and secrets
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Credentials, API keys, OAuth tokens, and trust configuration are
            stored in a protected vault that lives outside the workspace.
            On Cloud, this is the managed credential vault tied to your
            account. On local, it&apos;s a separate directory at{" "}
            <code>~/.vellum/protected/</code>.
          </p>
          <p className="mb-0 text-zinc-600">
            Either way, secrets are never included in diagnostic exports or
            workspace backups. The assistant can use these credentials to
            take actions on your behalf, but cannot read or display them in
            conversation.
          </p>
        </section>

        <section id="the-sandbox" className="mt-12">
          <SectionHeading id="the-sandbox" level={2}>
            The sandbox
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            On <strong>Vellum Cloud</strong>, your assistant runs in an
            isolated cloud sandbox. It can read and write files inside its
            own workspace, but has no access to a host machine, so the host
            tools and shell commands described below don&apos;t apply.
          </p>
          <p className="mb-4 text-zinc-600">
            On the <strong>desktop app</strong>, your assistant operates
            within a stricter boundary because it can also reach into your
            local machine:
          </p>
          <div className="mb-4 overflow-hidden rounded-xl border border-zinc-200">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-zinc-50">
                  <th className="px-4 py-3 text-left text-sm font-medium text-zinc-500 w-40">
                    Tool type
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-zinc-500">
                    Access
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-zinc-500 w-36">
                    Permission
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50">
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">
                    Workspace tools
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    file_read, file_write, file_edit - restricted
                    to <code>~/.vellum/workspace/</code>
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    No approval needed
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">
                    Host tools
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    host_file_read, host_file_write, host_file_edit -
                    can access files anywhere on your machine
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    Requires approval
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">
                    Shell commands
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    bash runs sandboxed in the workspace; host_bash runs on
                    your machine
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    host_bash requires approval
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mb-0 text-zinc-600">
            Path traversal (using <code>../</code> to escape the workspace) is
            blocked. Symlinks that point outside the boundary are rejected.
            On the desktop app, the sandbox is enforced at the OS level using{" "}
            <code>sandbox-exec</code> on macOS.
          </p>
        </section>

        <section id="why-this-matters" className="mt-12">
          <SectionHeading id="why-this-matters" level={2}>
            Why this matters
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>The parts that matter are readable.</strong> Your
              assistant&apos;s identity, personality, and knowledge about you
              are plain text files. Open them, read them, know exactly what your
              assistant thinks it knows.
            </li>
            <li>
              <strong>The parts that matter are editable.</strong> Don&apos;t
              like the personality? Edit SOUL.md. Wrong fact about you? Fix
              USER.md. Changes take effect next conversation.
            </li>
            <li>
              <strong>It&apos;s version-controlled.</strong> The workspace is a
              git repository. Every conversation turn is committed
              automatically, so you can see exactly what changed and when.
            </li>
            <li>
              <strong>It&apos;s yours.</strong> Your workspace lives in your
              private Vellum Cloud account, or on your own machine if you
              self-host. Credentials are stored separately and excluded from
              any exports. We don&apos;t share your workspace with other
              users, and we don&apos;t read it.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
