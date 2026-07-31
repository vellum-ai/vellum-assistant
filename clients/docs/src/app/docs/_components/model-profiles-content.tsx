"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const BADGE_STYLES: Record<string, string> = {
  Quality: "bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-300",
  Balanced: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300",
  "Cost Optimized": "bg-stone-100 text-stone-600 dark:bg-stone-500/20 dark:text-stone-400",
};

function ProfileBadge({ profile }: { profile: string }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${BADGE_STYLES[profile] ?? ""}`}>
      {profile}
    </span>
  );
}

const TOC_ITEMS = [
  { id: "overview", label: "Overview", level: 2 },
  { id: "built-in-profiles", label: "Built-in profiles", level: 2 },
  { id: "switching-profiles", label: "Switching profiles", level: 2 },
  { id: "per-conversation-override", label: "Per-conversation override", level: 2 },
  { id: "our-recommendation", label: "Our recommendation", level: 2 },
  { id: "action-overrides", label: "Action overrides", level: 2 },
];

export function ModelProfilesContent() {
  return (
    <>
      <DocsContent
        title="Model Profiles"
        breadcrumb="Docs / Key Concepts / Model Profiles"
        eyebrow="Key Concepts"
        subtitle="Control which LLM your assistant uses for each job (conversations, memory work, scheduled tasks) and override it per call-site when you need to."
      >
        {/* ------------------------------------------------------------------ */}
        {/* Overview                                                             */}
        {/* ------------------------------------------------------------------ */}
        <section id="overview">
          <SectionHeading id="overview" level={2}>
            Overview
          </SectionHeading>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            Model profiles control which AI model your assistant uses and how it behaves.
            You set one profile as the workspace-wide default, and your assistant applies
            it to everything: conversations, background memory work, scheduled tasks, and
            more. You can override it per conversation or per action type when you need
            different behavior.
          </p>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Built-in profiles                                                    */}
        {/* ------------------------------------------------------------------ */}
        <section id="built-in-profiles" className="mt-12">
          <SectionHeading id="built-in-profiles" level={2}>
            Built-in profiles
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            Every workspace starts with three built-in profiles. You can edit or
            duplicate them, but the defaults can&apos;t be deleted.
          </p>
          <div className="overflow-x-auto">
            <table className="mb-4 w-full text-sm text-stone-600 dark:text-stone-400">
              <thead>
                <tr className="border-b border-stone-200 dark:border-moss-600">
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Profile
                  </th>
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Model
                  </th>
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Best for
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50 dark:[&>tr:nth-child(even)]:bg-moss-900/30">
                <tr>
                  <td className="py-3 pr-4">
                    <span className="font-semibold text-stone-900 dark:text-stone-100">Quality</span>
                  </td>
                  <td className="py-3 pr-4">Claude Opus</td>
                  <td className="py-3">Deep research, complex reasoning, high-stakes tasks</td>
                </tr>
                <tr>
                  <td className="py-3 pr-4">
                    <span className="font-semibold text-stone-900 dark:text-stone-100">Balanced</span>
                  </td>
                  <td className="py-3 pr-4">MiniMax M3</td>
                  <td className="py-3">Everyday use: capable across the board at reasonable cost</td>
                </tr>
                <tr>
                  <td className="py-3 pr-4">
                    <span className="font-semibold text-stone-900 dark:text-stone-100">Cost Optimized</span>
                  </td>
                  <td className="py-3 pr-4">Claude Haiku</td>
                  <td className="py-3">Simple, short, or structural tasks where speed matters more than depth</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            <strong className="text-stone-900 dark:text-stone-100">Balanced is active by default.</strong>{" "}
            Every call your assistant makes (conversation replies, memory filing, title generation) runs with the Balanced profile unless you change it.
          </p>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Switching profiles                                                   */}
        {/* ------------------------------------------------------------------ */}
        <section id="switching-profiles" className="mt-12">
          <SectionHeading id="switching-profiles" level={2}>
            Switching profiles
          </SectionHeading>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            Open{" "}
            <strong className="text-stone-900 dark:text-stone-100">
              Settings → Inference Profiles
            </strong>{" "}
            and select a different active profile from the dropdown. The change applies
            workspace-wide immediately, no restart needed. You can also create custom
            profiles from this screen if you want to use a different provider or model
            not covered by the built-ins.
          </p>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Per-conversation override                                            */}
        {/* ------------------------------------------------------------------ */}
        <section id="per-conversation-override" className="mt-12">
          <SectionHeading id="per-conversation-override" level={2}>
            Per-conversation override
          </SectionHeading>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            Use the profile picker in the chat header to pin a different profile to a
            single conversation. It only affects that conversation: your workspace default
            stays untouched. This is the easiest way to run one session on a stronger or
            lighter model without changing anything globally.
          </p>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Our recommendation                                                   */}
        {/* ------------------------------------------------------------------ */}
        <section id="our-recommendation" className="mt-12">
          <SectionHeading id="our-recommendation" level={2}>
            Our recommendation
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            Keep <strong className="text-stone-900 dark:text-stone-100">Balanced</strong> as
            your active profile: it covers everyday use well. Then use Action Overrides
            to selectively upgrade the actions that benefit most from a stronger model, and
            step down only for tasks where the output is purely structural.
          </p>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            A good rule of thumb: anything that shows up directly in your conversation or
            drives a decision should stay on at least Sonnet. Tasks like generating a
            title, formatting a notification, or suggesting conversation starters are good
            candidates for a lighter model: they&apos;re short, easy to verify, and
            quality differences are barely noticeable.
          </p>
          <p className="mb-0 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200">
            <strong>Tip:</strong> use the per-conversation profile picker for one-off
            heavy tasks. Switch to Quality for a deep research session, then leave your
            workspace default untouched. That way you only pay for Opus when you
            explicitly reach for it.
          </p>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Action overrides                                                     */}
        {/* ------------------------------------------------------------------ */}
        <section id="action-overrides" className="mt-12">
          <SectionHeading id="action-overrides" level={2}>
            Action overrides
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            Open{" "}
            <strong className="text-stone-900 dark:text-stone-100">
              Settings → Inference Profiles → Action Overrides
            </strong>{" "}
            to assign a specific profile to individual actions. Each action has a toggle:
            when off it uses your active profile, when on you pick a profile just for
            that action. You can search by name and reset everything back to defaults at
            any time.
          </p>
          <div className="overflow-x-auto">
            <table className="mb-0 w-full text-sm text-stone-600 dark:text-stone-400">
              <thead>
                <tr className="border-b border-stone-200 dark:border-moss-600">
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Action
                  </th>
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    What it does
                  </th>
                  <th className="pb-3 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Recommended
                  </th>
                </tr>
              </thead>
              <tbody className="text-stone-600 dark:text-stone-400">
                {/* Agent loop */}
                <tr>
                  <td colSpan={3} className="pb-1 pt-5 text-xs font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500">
                    Agent loop
                  </td>
                </tr>
                <tr className="border-t border-stone-100 dark:border-moss-700">
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Main agent</td>
                  <td className="py-3 pr-4">The primary conversation agent that handles your messages</td>
                  <td className="py-3"><ProfileBadge profile="Quality" /></td>
                </tr>
                <tr className="border-t border-stone-100 dark:border-moss-700">
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Subagent spawn</td>
                  <td className="py-3 pr-4">Spawns a subagent to handle a delegated subtask</td>
                  <td className="py-3"><ProfileBadge profile="Quality" /></td>
                </tr>
                <tr className="border-t border-stone-100 dark:border-moss-700">
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Heartbeat agent</td>
                  <td className="py-3 pr-4">Runs background tasks and proactive checks on a schedule</td>
                  <td className="py-3"><ProfileBadge profile="Balanced" /></td>
                </tr>
                <tr className="border-t border-stone-100 dark:border-moss-700">
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Filing agent</td>
                  <td className="py-3 pr-4">Files memories and updates the knowledge base after conversations</td>
                  <td className="py-3"><ProfileBadge profile="Balanced" /></td>
                </tr>
                <tr className="border-t border-stone-100 dark:border-moss-700">
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Analyze conversation</td>
                  <td className="py-3 pr-4">Analyzes conversation content for summaries and insights</td>
                  <td className="py-3"><ProfileBadge profile="Balanced" /></td>
                </tr>
                <tr className="border-t border-stone-100 dark:border-moss-700">
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Call agent</td>
                  <td className="py-3 pr-4">Handles voice call conversations</td>
                  <td className="py-3"><ProfileBadge profile="Quality" /></td>
                </tr>
                {/* Memory */}
                <tr>
                  <td colSpan={3} className="pb-1 pt-5 text-xs font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500">
                    Memory
                  </td>
                </tr>
                <tr className="border-t border-stone-100 dark:border-moss-700">
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Memory · Extraction</td>
                  <td className="py-3 pr-4">Pulls facts and preferences out of conversations and stores them</td>
                  <td className="py-3"><ProfileBadge profile="Balanced" /></td>
                </tr>
                <tr className="border-t border-stone-100 dark:border-moss-700">
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Memory · Consolidation</td>
                  <td className="py-3 pr-4">Merges and deduplicates your memory store over time</td>
                  <td className="py-3"><ProfileBadge profile="Balanced" /></td>
                </tr>
                <tr className="border-t border-stone-100 dark:border-moss-700">
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Memory · Retrieval</td>
                  <td className="py-3 pr-4">Searches memory to surface relevant context during conversations</td>
                  <td className="py-3"><ProfileBadge profile="Balanced" /></td>
                </tr>
                <tr className="border-t border-stone-100 dark:border-moss-700">
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Narrative refinement</td>
                  <td className="py-3 pr-4">Refines and polishes stored narrative memory entries</td>
                  <td className="py-3"><ProfileBadge profile="Balanced" /></td>
                </tr>
                <tr className="border-t border-stone-100 dark:border-moss-700">
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Pattern scan</td>
                  <td className="py-3 pr-4">Scans conversation history to detect behavioral patterns</td>
                  <td className="py-3"><ProfileBadge profile="Balanced" /></td>
                </tr>
                <tr className="border-t border-stone-100 dark:border-moss-700">
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Conversation summarization</td>
                  <td className="py-3 pr-4">Summarizes long conversation threads for memory and context</td>
                  <td className="py-3"><ProfileBadge profile="Balanced" /></td>
                </tr>
                <tr className="border-t border-stone-100 dark:border-moss-700">
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Conversation starters</td>
                  <td className="py-3 pr-4">Generates suggested openers for new conversations</td>
                  <td className="py-3"><ProfileBadge profile="Cost Optimized" /></td>
                </tr>
                {/* Workspace */}
                <tr>
                  <td colSpan={3} className="pb-1 pt-5 text-xs font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500">
                    Workspace
                  </td>
                </tr>
                <tr className="border-t border-stone-100 dark:border-moss-700">
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Conversation title</td>
                  <td className="py-3 pr-4">Generates a title for each conversation</td>
                  <td className="py-3"><ProfileBadge profile="Cost Optimized" /></td>
                </tr>
                <tr className="border-t border-stone-100 dark:border-moss-700">
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Commit message generator</td>
                  <td className="py-3 pr-4">Writes git commit messages from staged changes</td>
                  <td className="py-3"><ProfileBadge profile="Balanced" /></td>
                </tr>
                {/* UI */}
                <tr>
                  <td colSpan={3} className="pb-1 pt-5 text-xs font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500">
                    UI
                  </td>
                </tr>
                <tr className="border-t border-stone-100 dark:border-moss-700">
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Identity intro</td>
                  <td className="py-3 pr-4">Generates your assistant&apos;s introductory message on first launch</td>
                  <td className="py-3"><ProfileBadge profile="Balanced" /></td>
                </tr>
                <tr className="border-t border-stone-100 dark:border-moss-700">
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Empty-state greeting</td>
                  <td className="py-3 pr-4">Generates the greeting shown on an empty conversation</td>
                  <td className="py-3"><ProfileBadge profile="Cost Optimized" /></td>
                </tr>
                {/* Notifications */}
                <tr>
                  <td colSpan={3} className="pb-1 pt-5 text-xs font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500">
                    Notifications
                  </td>
                </tr>
                <tr className="border-t border-stone-100 dark:border-moss-700">
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Notification decision</td>
                  <td className="py-3 pr-4">Decides whether to surface a proactive notification to you</td>
                  <td className="py-3"><ProfileBadge profile="Balanced" /></td>
                </tr>
                <tr className="border-t border-stone-100 dark:border-moss-700">
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Preference extraction</td>
                  <td className="py-3 pr-4">Learns your communication preferences from how you interact</td>
                  <td className="py-3"><ProfileBadge profile="Balanced" /></td>
                </tr>
                {/* Voice */}
                <tr>
                  <td colSpan={3} className="pb-1 pt-5 text-xs font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500">
                    Voice
                  </td>
                </tr>
                <tr className="border-t border-stone-100 dark:border-moss-700">
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Guardian question copy</td>
                  <td className="py-3 pr-4">Generates spoken prompts during guardian verification flows</td>
                  <td className="py-3"><ProfileBadge profile="Balanced" /></td>
                </tr>
                <tr className="border-t border-stone-100 dark:border-moss-700">
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Watch commentary</td>
                  <td className="py-3 pr-4">Produces live commentary delivered via Apple Watch</td>
                  <td className="py-3"><ProfileBadge profile="Balanced" /></td>
                </tr>
                <tr className="border-t border-stone-100 dark:border-moss-700">
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Watch summary</td>
                  <td className="py-3 pr-4">Generates brief summaries surfaced on Apple Watch</td>
                  <td className="py-3"><ProfileBadge profile="Cost Optimized" /></td>
                </tr>
                {/* Utility */}
                <tr>
                  <td colSpan={3} className="pb-1 pt-5 text-xs font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500">
                    Utility
                  </td>
                </tr>
                <tr className="border-t border-stone-100 dark:border-moss-700">
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Interaction classifier</td>
                  <td className="py-3 pr-4">Classifies the type of each inbound message to route it correctly</td>
                  <td className="py-3"><ProfileBadge profile="Cost Optimized" /></td>
                </tr>
                <tr className="border-t border-stone-100 dark:border-moss-700">
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Style analyzer</td>
                  <td className="py-3 pr-4">Analyzes your writing style to help your assistant match it</td>
                  <td className="py-3"><ProfileBadge profile="Balanced" /></td>
                </tr>
                <tr className="border-t border-stone-100 dark:border-moss-700">
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Invite instruction generator</td>
                  <td className="py-3 pr-4">Generates onboarding instructions for new assistant invites</td>
                  <td className="py-3"><ProfileBadge profile="Balanced" /></td>
                </tr>
                <tr className="border-t border-stone-100 dark:border-moss-700">
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Skill category inference</td>
                  <td className="py-3 pr-4">Automatically categorizes installed skills</td>
                  <td className="py-3"><ProfileBadge profile="Cost Optimized" /></td>
                </tr>
                {/* Skills */}
                <tr>
                  <td colSpan={3} className="pb-1 pt-5 text-xs font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500">
                    Skills
                  </td>
                </tr>
                <tr className="border-t border-stone-100 dark:border-moss-700">
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Meet · Consent monitor</td>
                  <td className="py-3 pr-4">Monitors meeting consent during Google Meet sessions</td>
                  <td className="py-3"><ProfileBadge profile="Balanced" /></td>
                </tr>
                <tr className="border-t border-stone-100 dark:border-moss-700">
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Meet · Chat opportunity</td>
                  <td className="py-3 pr-4">Identifies moments to send a helpful message during meetings</td>
                  <td className="py-3"><ProfileBadge profile="Balanced" /></td>
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
