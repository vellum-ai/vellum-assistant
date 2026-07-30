"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";

const SKILL_PAGES = [
  { title: "Gmail", href: "/docs/skills-reference/gmail", description: "Full Gmail management — archive, label, draft, send, unsubscribe, and manage filters." },
  { title: "Google Calendar", href: "/docs/skills-reference/google-calendar", description: "View your schedule, create events, and manage your calendar." },
  { title: "Slack", href: "/docs/skills-reference/slack", description: "Scan channels, summarize threads, manage reactions, and configure Slack integration." },
  { title: "Messaging", href: "/docs/skills-reference/messaging", description: "Read, search, send, and manage messages across multiple platforms." },
  { title: "Phone Calls", href: "/docs/skills-reference/phone-calls", description: "Make and receive phone calls with real-time voice conversation via Twilio." },
  { title: "Browser", href: "/docs/skills-reference/browser", description: "Navigate web pages, interact with elements, extract content, and fill forms." },
  { title: "Computer Use", href: "/docs/skills-reference/computer-use", description: "Control your Mac directly — observe the screen and perform actions via accessibility APIs." },
  { title: "Screen Watch", href: "/docs/skills-reference/screen-watch", description: "Observe your screen at regular intervals using OCR for contextual assistance." },
  { title: "Image Studio", href: "/docs/skills-reference/image-studio", description: "Generate and edit images using AI models." },
  { title: "Document", href: "/docs/skills-reference/document", description: "Create and edit long-form text — blog posts, articles, essays, and reports." },
  { title: "App Builder", href: "/docs/skills-reference/app-builder", description: "Create fully interactive web applications from natural language descriptions." },

  { title: "Tasks", href: "/docs/skills-reference/tasks", description: "Reusable task templates and a prioritized work queue." },
  { title: "Schedule", href: "/docs/skills-reference/schedule", description: "Set up recurring and one-shot scheduled actions." },
  { title: "Contacts", href: "/docs/skills-reference/contacts", description: "Manage contacts, communication channels, and access control." },
  { title: "Followups", href: "/docs/skills-reference/followups", description: "Track messages awaiting responses across all communication channels." },
  { title: "Notifications", href: "/docs/skills-reference/notifications", description: "Send notifications through a unified routing system across your channels." },
  { title: "Playbooks", href: "/docs/skills-reference/playbooks", description: "Trigger-action automation rules for handling incoming messages." },

  { title: "Subagent", href: "/docs/skills-reference/subagent", description: "Spawn autonomous background agents that work independently on tasks." },
  { title: "Watcher", href: "/docs/skills-reference/watcher", description: "Poll external services for changes and notify you when something happens." },
  { title: "Media Processing", href: "/docs/skills-reference/media-processing", description: "Process video, audio, and image files through a multi-phase pipeline." },
  { title: "Transcribe", href: "/docs/skills-reference/transcribe", description: "Transcribe audio and video files using Whisper." },
  { title: "Start the Day", href: "/docs/skills-reference/start-the-day", description: "Personalized daily briefing with weather, calendar, news, and tasks." },
  { title: "Weather", href: "/docs/skills-reference/weather", description: "Current conditions and multi-day forecasts for any location." },
  { title: "Amazon", href: "/docs/skills-reference/amazon", description: "Search, browse, and shop on Amazon and Amazon Fresh." },
  { title: "DoorDash", href: "/docs/skills-reference/doordash", description: "Order food, groceries, and convenience items from DoorDash." },
  { title: "Email (Agent Mail)", href: "/docs/skills-reference/email-agentmail", description: "Give your assistant its own email address to send and receive mail." },
  { title: "Skill Management", href: "/docs/skills-reference/skill-management", description: "Create and delete custom managed skills to extend your assistant." },
  { title: "ChatGPT Import", href: "/docs/skills-reference/chatgpt-import", description: "Import your ChatGPT conversation history into Vellum." },
  { title: "ACP", href: "/docs/skills-reference/acp", description: "Delegate development tasks through the Agent Client Protocol." },
];

export function SkillsReferenceContent() {
  return (
    <DocsContent title="Skills Reference" breadcrumb="Docs / Skills Reference">
      <p className="mb-6 text-zinc-600">
        Everything your assistant can do out of the box. One page per skill, same format
        throughout. Scan what you need, skip what you don&apos;t.
      </p>

      <p className="mb-3 text-zinc-600">Each skill page covers:</p>
      <ul className="mb-6 list-disc space-y-2 pl-6 text-zinc-600">
        <li><strong>What it does</strong> — one sentence</li>
        <li><strong>Setup required</strong> — what you need before first use</li>
        <li><strong>Permissions</strong> — what access it needs</li>
        <li><strong>Common prompts</strong> — things you can say to use it</li>
        <li><strong>Configuration</strong> — options and settings</li>
        <li><strong>Tips &amp; gotchas</strong> — the stuff nobody tells you</li>
      </ul>

      <div className="docs-nav-cards">
        {SKILL_PAGES.map((page) => (
          <a key={page.href} href={page.href} className="docs-nav-card">
            <div className="docs-nav-card-content">
              <span className="docs-nav-card-title">{page.title}</span>
              <span className="docs-nav-card-desc">{page.description}</span>
            </div>
            <span className="docs-nav-card-arrow" aria-hidden="true">→</span>
          </a>
        ))}
      </div>
    </DocsContent>
  );
}
