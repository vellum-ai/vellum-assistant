"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "integrations", label: "Integrations", level: 2 },
  { id: "dynamic-skill-authoring", label: "Dynamic Skill Authoring", level: 2 },
  { id: "browser", label: "Browser", level: 2 },
  { id: "attachments", label: "Attachments", level: 2 },
  { id: "inline-media-embeds", label: "Inline Media Embeds", level: 2 },
];

export function DeveloperGuideFeaturesContent() {
  return (
    <>
      <DocsContent title="Features & Capabilities" breadcrumb="Docs / Developer Guide / Features">
        <p className="mb-8 text-zinc-600">
          A deep dive into the platform&apos;s major feature areas — integrations, skill authoring, browser automation,
          file attachments, and media embeds.
        </p>

        {/* Integrations */}
        <section id="integrations">
          <SectionHeading id="integrations" level={2}>
            Integrations
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Vellum integrates with third-party services via OAuth2, each exposed as a bundled skill with its own set of tools.
          </p>
          <p className="mb-4 text-zinc-600">
            The unified messaging layer provides platform-agnostic tools (<code className="text-sm">messaging_send</code>,{" "}
            <code className="text-sm">messaging_read</code>, <code className="text-sm">messaging_search</code>) that delegate to
            provider adapters for Gmail, Slack, and Telegram. Platform-specific tools (e.g.{" "}
            <code className="text-sm">gmail_archive</code>, <code className="text-sm">slack_add_reaction</code>) extend beyond the
            generic interface.
          </p>
          <p className="mb-4 text-zinc-600">
            Connect via the Settings UI or the <code className="text-sm">integration_connect</code> HTTP endpoint.
            OAuth2 tokens are stored in the credential vault — the LLM never sees raw tokens. Telegram uses a bot token (not OAuth).
          </p>
        </section>

        {/* Dynamic Skill Authoring */}
        <section id="dynamic-skill-authoring" className="mt-12">
          <SectionHeading id="dynamic-skill-authoring" level={2}>
            Dynamic Skill Authoring
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            The assistant can create, test, and persist new skills at runtime when no existing tool covers a user&apos;s need.
          </p>
          <ol className="mb-6 list-decimal space-y-2 pl-6 text-zinc-600">
            <li><strong>Evaluate</strong> — drafts a TypeScript snippet, tests in a sandbox via <code className="text-sm">evaluate_typescript_code</code>. Iterates until it passes.</li>
            <li><strong>Persist</strong> — writes the skill to <code className="text-sm">~/.vellum/workspace/skills/&lt;id&gt;/</code> via <code className="text-sm">scaffold_managed_skill</code>.</li>
            <li><strong>Load</strong> — calls <code className="text-sm">skill_load</code> to activate the new skill.</li>
            <li><strong>Delete</strong> — removes via <code className="text-sm">delete_managed_skill</code>.</li>
          </ol>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-700">
                  <th className="py-2 pr-4 text-left font-medium text-zinc-900 dark:text-zinc-100">Tool</th>
                  <th className="py-2 pr-4 text-left font-medium text-zinc-900 dark:text-zinc-100">Risk</th>
                  <th className="py-2 text-left font-medium text-zinc-900 dark:text-zinc-100">Description</th>
                </tr>
              </thead>
              <tbody className="text-zinc-600 dark:text-zinc-400">
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><code className="text-xs">evaluate_typescript_code</code></td>
                  <td className="py-2 pr-4">High</td>
                  <td className="py-2">Run a TypeScript snippet in a sandbox</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><code className="text-xs">scaffold_managed_skill</code></td>
                  <td className="py-2 pr-4">High</td>
                  <td className="py-2">Write a managed skill with SKILL.md frontmatter</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4"><code className="text-xs">delete_managed_skill</code></td>
                  <td className="py-2 pr-4">High</td>
                  <td className="py-2">Remove a managed skill directory and index entry</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-sm text-zinc-500">
            All authoring tools require explicit user approval. Skills can declare child relationships via the{" "}
            <code className="text-sm">includes</code> frontmatter field. Managed skills appear in the macOS Settings UI.
          </p>
        </section>

        {/* Browser */}
        <section id="browser" className="mt-12">
          <SectionHeading id="browser" level={2}>
            Browser
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Web browsing is provided by the bundled <code className="text-sm">browser</code> skill. Activate via{" "}
            <code className="text-sm">/browser</code> or let the agent load it automatically. Browser automation is
            executed through <code className="text-sm">assistant browser</code> commands.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-700">
                  <th className="py-2 pr-4 text-left font-medium text-zinc-900 dark:text-zinc-100">Command</th>
                  <th className="py-2 text-left font-medium text-zinc-900 dark:text-zinc-100">Description</th>
                </tr>
              </thead>
              <tbody className="text-zinc-600 dark:text-zinc-400">
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><code className="text-xs">assistant browser navigate</code></td>
                  <td className="py-2">Navigate to a URL</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><code className="text-xs">assistant browser snapshot</code></td>
                  <td className="py-2">List interactive elements</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><code className="text-xs">assistant browser screenshot</code></td>
                  <td className="py-2">Take a visual screenshot</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><code className="text-xs">assistant browser click</code></td>
                  <td className="py-2">Click an element</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><code className="text-xs">assistant browser type</code></td>
                  <td className="py-2">Type text into an input</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><code className="text-xs">assistant browser press_key</code></td>
                  <td className="py-2">Press a keyboard key</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><code className="text-xs">assistant browser wait_for</code></td>
                  <td className="py-2">Wait for a condition</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><code className="text-xs">assistant browser extract</code></td>
                  <td className="py-2">Extract page text content</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><code className="text-xs">assistant browser fill_credential</code></td>
                  <td className="py-2">Fill a stored credential into a form field</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4"><code className="text-xs">assistant browser close</code></td>
                  <td className="py-2">Close the browser page</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-sm text-zinc-500">
            All browser operations are auto-allowed by default. Navigation with{" "}
            <code className="text-sm">allow_private_network=true</code> is elevated to high-risk.
          </p>
        </section>

        {/* Attachments */}
        <section id="attachments" className="mt-12">
          <SectionHeading id="attachments" level={2}>
            Attachments
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            The assistant attaches files and images to replies, delivered across three channels:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li><strong>Desktop</strong> — inline base64 in SSE events; macOS app renders thumbnails</li>
            <li><strong>Telegram</strong> — gateway delivers via <code className="text-sm">sendPhoto</code>/<code className="text-sm">sendDocument</code> (20 MB limit)</li>
            <li><strong>HTTP API</strong> — <code className="text-sm">GET /v1/assistants/:id/messages</code> returns metadata; <code className="text-sm">GET /v1/assistants/:assistantId/attachments/:attachmentId</code> returns full payload</li>
          </ul>
          <p className="mb-4 text-zinc-600">
            Sources: <code className="text-sm">&lt;vellum-attachment&gt;</code> directives in response text, or auto-converted from
            tool output. Limit: 100 MB per attachment.
          </p>
        </section>

        {/* Media Embeds */}
        <section id="inline-media-embeds" className="mt-12">
          <SectionHeading id="inline-media-embeds" level={2}>
            Inline Media Embeds
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            The desktop app renders inline previews for images and video URLs (YouTube, Vimeo, Loom).
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>Videos use <strong>ephemeral webview storage</strong> — no cookies persist between sessions</li>
            <li>Videos require <strong>click to play</strong>; nothing auto-plays</li>
            <li>Images are <strong>lazy-loaded</strong></li>
            <li>Video webviews are <strong>torn down when scrolled offscreen</strong></li>
          </ul>
          <p className="mb-4 text-zinc-600">
            Controlled via <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-sm dark:bg-zinc-800">ui.mediaEmbeds</code> in{" "}
            <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-sm dark:bg-zinc-800">~/.vellum/workspace/config.json</code>.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-700">
                  <th className="py-2 pr-4 text-left font-medium text-zinc-900 dark:text-zinc-100">Setting</th>
                  <th className="py-2 pr-4 text-left font-medium text-zinc-900 dark:text-zinc-100">Default</th>
                  <th className="py-2 text-left font-medium text-zinc-900 dark:text-zinc-100">Description</th>
                </tr>
              </thead>
              <tbody className="text-zinc-600 dark:text-zinc-400">
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><code className="text-xs">enabled</code></td>
                  <td className="py-2 pr-4"><code className="text-xs">true</code></td>
                  <td className="py-2">Global toggle for all inline media embeds</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><code className="text-xs">videoAllowlistDomains</code></td>
                  <td className="py-2 pr-4"><code className="text-xs">[&quot;youtube.com&quot;, ...]</code></td>
                  <td className="py-2">Domains allowed to render video embeds</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4"><code className="text-xs">enabledSince</code></td>
                  <td className="py-2 pr-4"><em>timestamp</em></td>
                  <td className="py-2">Only messages after this date show embeds</td>
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
