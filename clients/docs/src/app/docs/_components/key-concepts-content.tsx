"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";

export function KeyConceptsContent() {
  return (
    <DocsContent title="Key Concepts" breadcrumb="Docs / Key Concepts">
      <p className="mb-6 text-zinc-600">
        This is the &quot;how does this thing actually work?&quot; section. Not a wall of
        jargon. Not a system design interview. Just the mental models you need to
        understand what&apos;s happening under the hood so you can get the most out of
        your assistant.
      </p>

      <div className="docs-nav-cards">
        <a href="/docs/key-concepts/the-workspace" className="docs-nav-card">
          <div className="docs-nav-card-content">
            <span className="docs-nav-card-title">The Workspace</span>
            <span className="docs-nav-card-desc">Your assistant&apos;s brain is a folder. Here&apos;s what&apos;s in it.</span>
          </div>
          <span className="docs-nav-card-arrow" aria-hidden="true">→</span>
        </a>
        <a href="/docs/key-concepts/skills-and-tools" className="docs-nav-card">
          <div className="docs-nav-card-content">
            <span className="docs-nav-card-title">Tools &amp; Skills</span>
            <span className="docs-nav-card-desc">What your assistant can do, and how it learns new tricks.</span>
          </div>
          <span className="docs-nav-card-arrow" aria-hidden="true">→</span>
        </a>
        <a href="/docs/key-concepts/memory-and-context" className="docs-nav-card">
          <div className="docs-nav-card-content">
            <span className="docs-nav-card-title">Memory &amp; Context</span>
            <span className="docs-nav-card-desc">How it remembers you across conversations.</span>
          </div>
          <span className="docs-nav-card-arrow" aria-hidden="true">→</span>
        </a>
        <a href="/docs/key-concepts/model-profiles" className="docs-nav-card">
          <div className="docs-nav-card-content">
            <span className="docs-nav-card-title">Model Profiles</span>
            <span className="docs-nav-card-desc">Pick which LLM runs each job, and override it when you need to.</span>
          </div>
          <span className="docs-nav-card-arrow" aria-hidden="true">→</span>
        </a>
        <a href="/docs/key-concepts/channels" className="docs-nav-card">
          <div className="docs-nav-card-content">
            <span className="docs-nav-card-title">Channels</span>
            <span className="docs-nav-card-desc">Where you can talk to your assistant.</span>
          </div>
          <span className="docs-nav-card-arrow" aria-hidden="true">→</span>
        </a>
        <a href="/docs/key-concepts/scheduling" className="docs-nav-card">
          <div className="docs-nav-card-content">
            <span className="docs-nav-card-title">Scheduling</span>
            <span className="docs-nav-card-desc">How your assistant gets things done on its own clock.</span>
          </div>
          <span className="docs-nav-card-arrow" aria-hidden="true">→</span>
        </a>
        <a href="/docs/key-concepts/web-search" className="docs-nav-card">
          <div className="docs-nav-card-content">
            <span className="docs-nav-card-title">Web Search</span>
            <span className="docs-nav-card-desc">How your assistant looks things up online, and which provider does it.</span>
          </div>
          <span className="docs-nav-card-arrow" aria-hidden="true">→</span>
        </a>
        <a href="/docs/key-concepts/oauth-integrations" className="docs-nav-card">
          <div className="docs-nav-card-content">
            <span className="docs-nav-card-title">OAuth Integrations</span>
            <span className="docs-nav-card-desc">Connect your assistant to Slack, Gmail, GitHub, Notion, and more.</span>
          </div>
          <span className="docs-nav-card-arrow" aria-hidden="true">→</span>
        </a>
      </div>

      <p className="mb-0 text-zinc-600">
        You don&apos;t have to read these in order. Jump to whatever&apos;s interesting.
      </p>
    </DocsContent>
  );
}
