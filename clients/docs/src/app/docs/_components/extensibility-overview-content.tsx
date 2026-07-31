"use client";

import Link from "next/link";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "what-is-a-plugin", label: "What is a plugin?", level: 2 },
  { id: "the-surfaces", label: "The surfaces a plugin can bundle", level: 2 },
  {
    id: "developing-plugins",
    label: "Developing plugins",
    level: 2,
  },
  {
    id: "coming-from-another-harness",
    label: "Coming from another harness?",
    level: 2,
  },
];

const linkClass =
  "font-semibold text-emerald-700 underline hover:text-emerald-800";

const PLUGIN_API_URL =
  "https://github.com/vellum-ai/vellum-assistant/tree/main/assistant/src/plugin-api";

const HOOKS_PAGE_URL = "/docs/extensibility/hooks";
const SKILLS_PAGE_URL = "/docs/extensibility/skills";
const TOOLS_PAGE_URL = "/docs/extensibility/tools";
const ROUTES_PAGE_URL = "/docs/extensibility/routes";
const APPS_PAGE_URL = "/docs/extensibility/apps";

export function ExtensibilityOverviewContent() {
  return (
    <>
      <DocsContent
        title="Extensibility"
        breadcrumb="Docs / Extensibility"
        subtitle="Build on top of Vellum with plugins. A plugin bundles hooks, tools, and more into a single installable package that extends what your assistant can do."
      >
        <p className="mb-8 text-zinc-600 dark:text-zinc-400">
          This section covers how you can teach your Assistant to extend itself
          by building new features without touching the core harness logic.
        </p>

        <section id="what-is-a-plugin">
          <SectionHeading id="what-is-a-plugin" level={2}>
            What is a plugin?
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            A plugin is a directory in your assistant&apos;s workspace (
            <code>&lt;workspaceDir&gt;/plugins/&lt;name&gt;/</code>) that groups
            different surfaces into one cohesive capability that they can now
            perform. Your assistant can build plugins directly in this folder in
            the workspace or install one from the community via the CLI:
          </p>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`assistant plugins install <name>`}</code>
          </pre>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            Plugins can also be discovered and managed from the Plugins tab in{" "}
            the app, or searched from the CLI with{" "}
            <code>assistant plugins search</code>. The catalog is a curated{" "}
            allowlist that the Vellum team approves and curates.
          </p>
        </section>

        <section id="the-surfaces" className="mt-12">
          <SectionHeading id="the-surfaces" level={2}>
            The surfaces a plugin can bundle
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            A single plugin can contribute several different kinds of behavior.
            Each surface is discovered by convention from a named subdirectory.
            Missing directories are simply skipped, so a plugin contributes only
            what it ships.
          </p>
          <div className="mb-4 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left dark:border-zinc-700">
                  <th className="py-2 pr-4 font-semibold text-zinc-900 dark:text-zinc-100">
                    Surface
                  </th>
                  <th className="py-2 pr-4 font-semibold text-zinc-900 dark:text-zinc-100">
                    Lives in
                  </th>
                  <th className="py-2 font-semibold text-zinc-900 dark:text-zinc-100">
                    What it does
                  </th>
                </tr>
              </thead>
              <tbody className="text-zinc-600 dark:text-zinc-400">
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4">
                    <Link href={HOOKS_PAGE_URL} className={linkClass}>
                      Lifecycle hooks
                    </Link>
                  </td>
                  <td className="py-2 pr-4">
                    <code>hooks/&lt;name&gt;.ts</code>
                  </td>
                  <td className="py-2">
                    Run code at fixed points in the Assistant&apos;s lifecycle
                    to read or transform what flows through.
                  </td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4">
                    <Link href={SKILLS_PAGE_URL} className={linkClass}>
                      Skills
                    </Link>
                  </td>
                  <td className="py-2 pr-4">
                    <code>skills/&lt;name&gt;/</code>
                  </td>
                  <td className="py-2">
                    Directories of instructions and associated assets, scripts,
                    and resources that the Assistant loads dynamically when
                    relevant.
                  </td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4">
                    <Link href={TOOLS_PAGE_URL} className={linkClass}>
                      Model-visible tools
                    </Link>
                  </td>
                  <td className="py-2 pr-4">
                    <code>tools/&lt;name&gt;.ts</code>
                  </td>
                  <td className="py-2">
                    Add new tools the model can call. Plugin tools land in the
                    same catalog as built-in tools.
                  </td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4">
                    <Link href={ROUTES_PAGE_URL} className={linkClass}>
                      HTTP routes
                    </Link>
                  </td>
                  <td className="py-2 pr-4">
                    <code>routes/&lt;path&gt;.ts</code>
                  </td>
                  <td className="py-2">
                    Serve HTTP endpoints (webhooks, integrations, callbacks) in
                    the plugin&apos;s own <code>/x/plugins/&lt;name&gt;/</code>{" "}
                    namespace.
                  </td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4">
                    <Link href={APPS_PAGE_URL} className={linkClass}>
                      Apps
                    </Link>
                  </td>
                  <td className="py-2 pr-4">
                    <code>apps/&lt;app&gt;/</code>
                  </td>
                  <td className="py-2">
                    Ship persistent, interactive apps (dashboards, tools, games)
                    served in the workspace panel, built as compiled React.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            The two extensibility patterns serve different goals.{" "}
            <strong>Plugins are for distribution</strong>: you intend to share
            the capability, publish to the marketplace, or install it across
            multiple assistants. The plugin manifest (<code>package.json</code>
            ), the <code>@vellumai/plugin-api</code> peer dependency, and the
            install flow exist to make a capability portable, versioned, and
            discoverable by others.
          </p>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            <strong>
              Direct workspace contributions are for personal extension
            </strong>
            : you simply want to extend <i>your</i> assistant and have no
            intention of distributing the work. Skip the plugin packaging
            entirely. Drop the file directly into the matching top-level
            workspace directory (<code>/workspace/tools/&lt;name&gt;/</code> for
            a tool, <code>/workspace/skills/&lt;name&gt;/</code> for a skill,{" "}
            <code>/workspace/hooks/&lt;event&gt;.ts</code> for a lifecycle hook)
            and the assistant picks it up automatically. No manifest, no install
            step, no peer dependency.
          </p>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            Several surfaces that plugins contribute run in the same process as
            the main Assistant process. They can import all internal methods
            from the Assistant from the single public package,{" "}
            <Link href={PLUGIN_API_URL} className={linkClass}>
              <code>@vellumai/plugin-api</code>
            </Link>
            , which is the only supported contract. Anything not exported from
            there is internal and can change without notice.
          </p>
        </section>

<section id="developing-plugins" className="mt-12">
          <SectionHeading id="developing-plugins" level={2}>
            Developing plugins
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            If you have an idea for a capability your assistant lacks, lean
            on your assistant to do the work. Describe what you want in
            plain language and let it scaffold the plugin, fill in the
            surfaces, and handle the publishing flow. Most users never
            need to touch the <code>assistant plugins</code> CLI directly:
            your assistant runs those commands on your behalf when you ask
            it to install, search, or publish.
          </p>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            The pages in this section are also available to your assistant
            through the <code>plugin-builder</code> skill, so when you ask
            it to build a plugin it will reference the same surface
            contracts, manifest fields, and CLI commands documented here.
            The docs you are reading and the skill your assistant reads
            are kept in sync.
          </p>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            If you do want to drive the process yourself, whether to learn how plugins work or to build one without involving your assistant, the CLI and the page-by-page references below
            cover everything end to end.
          </p>
        </section>

        <section id="coming-from-another-harness" className="mt-12">
          <SectionHeading id="coming-from-another-harness" level={2}>
            Coming from another harness?
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Vellum&apos;s plugin model was designed to line up with the agent
            harnesses you may already use. The shared vocabulary is deliberate
            to be as portable as possible with the other entrants in the
            industry.
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
