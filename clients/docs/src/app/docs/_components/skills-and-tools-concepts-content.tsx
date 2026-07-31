"use client";

import Image from "next/image";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "tools-the-atomic-actions", label: "Tools: the atomic actions", level: 2 },
  { id: "skills-bundles-of-capability", label: "Skills: bundles of capability", level: 2 },
  { id: "built-in-skills", label: "Built-in skills", level: 2 },
  { id: "how-skills-load", label: "How skills load", level: 2 },
  { id: "custom-and-community-skills", label: "Custom and community skills", level: 2 },
  { id: "voice", label: "Voice", level: 2 },
  { id: "the-difference-summarized", label: "The difference, summarized", level: 2 },
];

export function SkillsAndToolsConceptsContent() {
  return (
    <>
      <DocsContent title="Tools & Skills" breadcrumb="Docs / Key Concepts / Tools & Skills">
        <p className="mb-8 text-zinc-600">
          These are two related but different things. Understanding the
          difference will help you get more out of your assistant.
        </p>

        <div className="mb-12 overflow-hidden rounded-xl border border-stone-200 bg-white dark:border-moss-600/50 dark:bg-moss-700">
          <Image
            src="/docs/docs-skills-list.webp"
            alt="The Skills tab on the About your assistant screen, showing the list of installed skills with icons, descriptions, and category filters in the sidebar"
            width={3584}
            height={2094}
            unoptimized
            className="w-full"
          />
        </div>

        <section id="tools-the-atomic-actions">
          <SectionHeading id="tools-the-atomic-actions" level={2}>
            Tools: the atomic actions
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Tools are individual actions your assistant can take. Each one does
            exactly one thing.
          </p>
          <p className="mb-4 text-zinc-600">
            Core tools are always available in every conversation:
          </p>
          <div className="mb-6 overflow-hidden rounded-xl border border-zinc-200">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-zinc-50">
                  <th className="px-4 py-3 text-left text-sm font-medium text-zinc-500">
                    Tool
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-zinc-500">
                    What it does
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50">
                <tr>
                  <td className="px-4 py-3"><code>file_read</code></td>
                  <td className="px-4 py-3 text-zinc-600">Read a file in the workspace</td>
                </tr>
                <tr>
                  <td className="px-4 py-3"><code>file_write</code></td>
                  <td className="px-4 py-3 text-zinc-600">Create or overwrite a file in the workspace</td>
                </tr>
                <tr>
                  <td className="px-4 py-3"><code>file_edit</code></td>
                  <td className="px-4 py-3 text-zinc-600">Edit a file in the workspace (surgical find-and-replace)</td>
                </tr>
                <tr>
                  <td className="px-4 py-3"><code>bash</code></td>
                  <td className="px-4 py-3 text-zinc-600">Run a shell command (sandboxed to the workspace)</td>
                </tr>
                <tr>
                  <td className="px-4 py-3"><code>web_search</code></td>
                  <td className="px-4 py-3 text-zinc-600">Search the internet</td>
                </tr>
                <tr>
                  <td className="px-4 py-3"><code>web_fetch</code></td>
                  <td className="px-4 py-3 text-zinc-600">Fetch and extract content from a URL</td>
                </tr>
                <tr>
                  <td className="px-4 py-3"><code>memory_manage</code></td>
                  <td className="px-4 py-3 text-zinc-600">Save, update, or delete facts in long-term memory</td>
                </tr>
                <tr>
                  <td className="px-4 py-3"><code>memory_recall</code></td>
                  <td className="px-4 py-3 text-zinc-600">Search long-term memory</td>
                </tr>
                <tr>
                  <td className="px-4 py-3"><code>skill_load</code></td>
                  <td className="px-4 py-3 text-zinc-600">Activate a skill for the current conversation</td>
                </tr>
                <tr>
                  <td className="px-4 py-3"><code>skill_execute</code></td>
                  <td className="px-4 py-3 text-zinc-600">Run a tool provided by a loaded skill</td>
                </tr>
                <tr>
                  <td className="px-4 py-3"><code>credential_store</code></td>
                  <td className="px-4 py-3 text-zinc-600">Manage credentials (prompt, store, connect OAuth)</td>
                </tr>
                <tr>
                  <td className="px-4 py-3"><code>request_system_permission</code></td>
                  <td className="px-4 py-3 text-zinc-600">Ask you to grant a macOS system permission</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mb-4 text-zinc-600">
            Host tools can access your full machine, but require your
            permission:
          </p>
          <div className="mb-6 overflow-hidden rounded-xl border border-zinc-200">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-zinc-50">
                  <th className="px-4 py-3 text-left text-sm font-medium text-zinc-500">
                    Tool
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-zinc-500">
                    What it does
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50">
                <tr>
                  <td className="px-4 py-3"><code>host_file_read</code></td>
                  <td className="px-4 py-3 text-zinc-600">Read any file on your computer</td>
                </tr>
                <tr>
                  <td className="px-4 py-3"><code>host_file_write</code></td>
                  <td className="px-4 py-3 text-zinc-600">Write to any file on your computer</td>
                </tr>
                <tr>
                  <td className="px-4 py-3"><code>host_file_edit</code></td>
                  <td className="px-4 py-3 text-zinc-600">Edit any file on your computer</td>
                </tr>
                <tr>
                  <td className="px-4 py-3"><code>host_bash</code></td>
                  <td className="px-4 py-3 text-zinc-600">Run a shell command on your machine (unsandboxed)</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mb-4 text-zinc-600">
            Skill tools become available when their skill is loaded. For
            example, loading the Browser skill enables{" "}
            <code>assistant browser</code> commands: navigate, click,
            type, snapshot, extract, and others. Loading the Gmail skill
            adds tools for archiving, labeling, drafting, sending,
            unsubscribing, and more.
          </p>
          <p className="mb-0 text-zinc-600">
            There are dozens of tools in total. Your assistant picks the right
            ones based on what you asked for.
          </p>
        </section>

        <section id="skills-bundles-of-capability" className="mt-12">
          <SectionHeading id="skills-bundles-of-capability" level={2}>
            Skills: bundles of capability
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            A skill is a package that combines tools, instructions, and
            configuration into a coherent capability.
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Tool</strong> = &quot;I can draft an email&quot;
            </li>
            <li>
              <strong>Skill</strong> = &quot;I know how to browse the web:
              the Browser skill drives <code>assistant browser</code> commands
              to navigate pages, click elements, fill forms, extract content,
              take screenshots, and handle authentication&quot;
            </li>
          </ul>
          <p className="mb-4 text-zinc-600">
            Skills give your assistant context about how to use tools for a
            specific purpose. The Gmail skill knows email workflows. The Browser
            skill knows how to interact with web pages. The Phone Calls skill
            knows how to make and receive voice calls through Twilio.
          </p>
          <p className="mb-4 text-zinc-600">
            At minimum, a skill is just a single file:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>SKILL.md</strong>: instructions that teach the
              assistant when and how to use the skill
            </li>
          </ul>
          <p className="mb-4 text-zinc-600">
            More complex skills that provide their own tools also include:
          </p>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>TOOLS.json</strong>: a manifest defining what tools
              the skill provides, their inputs, risk levels, and execution
              targets
            </li>
            <li>
              <strong>tools/</strong>: the implementation code behind
              each tool
            </li>
          </ul>
        </section>

        <section id="built-in-skills" className="mt-12">
          <SectionHeading id="built-in-skills" level={2}>
            Built-in skills
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Your assistant ships with 28 bundled skills:
          </p>
          <div className="mb-0 overflow-hidden rounded-xl border border-zinc-200">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-zinc-50">
                  <th className="px-4 py-3 text-left text-sm font-medium text-zinc-500">
                    Category
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-zinc-500">
                    Skills
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-zinc-500">
                    What they enable
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50">
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">Communication</td>
                  <td className="px-4 py-3 text-zinc-600">Gmail, Slack, Messaging, Phone Calls, Sequences</td>
                  <td className="px-4 py-3 text-zinc-600">Read, send, and manage messages across platforms. Make and receive voice calls. Run email drip sequences.</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">Research &amp; content</td>
                  <td className="px-4 py-3 text-zinc-600">Browser, Document, Image Studio, Media Processing, Transcribe</td>
                  <td className="px-4 py-3 text-zinc-600">Navigate web pages, write long-form content, generate and edit images, process video/audio, transcribe recordings.</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">Productivity</td>
                  <td className="px-4 py-3 text-zinc-600">Google Calendar, Contacts, Tasks, Followups, Notifications, Schedule, Playbooks</td>
                  <td className="px-4 py-3 text-zinc-600">Manage calendar events and availability, track contacts, manage task queues, set reminders, build trigger-action automations.</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">Computer use</td>
                  <td className="px-4 py-3 text-zinc-600">Computer Use, Screen Watch</td>
                  <td className="px-4 py-3 text-zinc-600">Control your Mac directly: click, type, navigate between apps. Watch your screen with OCR at intervals.</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">Monitoring</td>
                  <td className="px-4 py-3 text-zinc-600">Watcher, Heartbeat</td>
                  <td className="px-4 py-3 text-zinc-600">Poll external sources for changes. Run periodic background checklists to keep things healthy.</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">Development</td>
                  <td className="px-4 py-3 text-zinc-600">App Builder, ACP, Subagent</td>
                  <td className="px-4 py-3 text-zinc-600">Build interactive web apps, delegate development tasks through ACP, run autonomous background agents.</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">System</td>
                  <td className="px-4 py-3 text-zinc-600">Settings, Skill Management, Skills Catalog, ChatGPT Import</td>
                  <td className="px-4 py-3 text-zinc-600">Configure the assistant, create custom skills, discover and install community skills, import history from other assistants.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section id="how-skills-load" className="mt-12">
          <SectionHeading id="how-skills-load" level={2}>
            How skills load
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Skills aren&apos;t all active at once. Your assistant sees a catalog
            of available skills (names, descriptions, and activation hints) in
            every conversation. When it determines a skill is relevant
            (because you asked about email, or said &quot;browse this
            page&quot;), it calls <code>skill_load</code> to activate it.
          </p>
          <p className="mb-4 text-zinc-600">
            Once a skill is loaded:
          </p>
          <ol className="mb-4 list-decimal space-y-2 pl-6 text-zinc-600">
            <li>
              Its full instructions (SKILL.md) are injected into the
              conversation context
            </li>
            <li>Its tools become available for use</li>
            <li>It stays active for the rest of the conversation</li>
          </ol>
          <p className="mb-0 text-zinc-600">
            This keeps the assistant&apos;s context focused. Only the skills
            that matter for the current conversation take up space.
          </p>
        </section>

        <section id="custom-and-community-skills" className="mt-12">
          <SectionHeading id="custom-and-community-skills" level={2}>
            Custom and community skills
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            If the built-in skills don&apos;t cover what you need, you have two
            options:
          </p>
          <p className="mb-4 text-zinc-600">
            <strong>Build your own.</strong> Describe what you want and your
            assistant will scaffold a full skill (SKILL.md with
            instructions, TOOLS.json with tool definitions, and TypeScript
            executors), then save it to your <code>skills/</code>{" "}
            directory. The skill is immediately available.
          </p>
          <blockquote className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-zinc-700">
            &quot;Build me a skill that monitors my favorite subreddit for new
            posts about TypeScript.&quot;
          </blockquote>
          <p className="mb-4 text-zinc-600">
            <strong>Install from the community.</strong> Community skills are
            published on the{" "}
            <a
              href="https://skills.sh"
              className="text-zinc-900 underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-900"
              target="_blank"
              rel="noopener noreferrer"
            >
              skills.sh
            </a>{" "}
            registry. Ask your assistant to search for a skill, and it can
            inspect, audit, and install it for you.
          </p>
          <p className="mb-0 text-zinc-600">
            Whether custom or community-installed, skills live in your{" "}
            <code>skills/</code> directory. You can inspect, modify, or delete
            any of them: a skill is just a folder with a few files.
          </p>
        </section>

        <section id="voice" className="mt-12">
          <SectionHeading id="voice" level={2}>
            Voice
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Voice is one of the built-in capabilities your assistant ships
            with. How it sounds and how you talk to it are both
            configurable:
          </p>
          <ul className="mb-4 list-disc space-y-1 pl-6 text-zinc-600">
            <li>
              <strong>TTS provider</strong>: which text-to-speech
              service to use (ElevenLabs, Fish Audio)
            </li>
            <li>
              <strong>Voice ID</strong>: the specific voice model
            </li>
            <li>
              <strong>Activation key</strong>: the push-to-talk key
              for voice input on desktop
            </li>
            <li>
              <strong>Conversation timeout</strong>: how long a
              voice conversation stays open after silence
            </li>
          </ul>
          <p className="mb-0 text-zinc-600">
            Voice settings are configured conversationally
            (&ldquo;change your voice&rdquo;) or through the Voice tab in
            Settings.
          </p>
        </section>

        <section id="the-difference-summarized" className="mt-12">
          <SectionHeading id="the-difference-summarized" level={2}>
            The difference, summarized
          </SectionHeading>
          <div className="mb-0 overflow-hidden rounded-xl border border-zinc-200">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-zinc-50">
                  <th className="px-4 py-3 text-left text-sm font-medium text-zinc-500"></th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-zinc-500">Tools</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-zinc-500">Skills</th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50">
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">What</td>
                  <td className="px-4 py-3 text-zinc-600">Single atomic action</td>
                  <td className="px-4 py-3 text-zinc-600">Bundle of tools + instructions</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">Example</td>
                  <td className="px-4 py-3 text-zinc-600"><code>gmail_draft</code></td>
                  <td className="px-4 py-3 text-zinc-600">Browser skill (<code>assistant browser</code> commands: navigate, click, type, extract, screenshot)</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">Availability</td>
                  <td className="px-4 py-3 text-zinc-600">Core tools are always on; skill tools load with their skill</td>
                  <td className="px-4 py-3 text-zinc-600">Activated per-conversation when relevant</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">Permissions</td>
                  <td className="px-4 py-3 text-zinc-600">Gated by execution target (sandbox vs. host)</td>
                  <td className="px-4 py-3 text-zinc-600">Skills themselves don&apos;t need permission; their individual tools do</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">Extensible</td>
                  <td className="px-4 py-3 text-zinc-600">Via MCP servers or custom skill tools</td>
                  <td className="px-4 py-3 text-zinc-600">Build your own or install from skills.sh</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">Think of it as</td>
                  <td className="px-4 py-3 text-zinc-600">A single LEGO brick</td>
                  <td className="px-4 py-3 text-zinc-600">A LEGO set with instructions</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
