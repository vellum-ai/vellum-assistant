"use client";

import Link from "next/link";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "when-to-ship-mcp", label: "When to ship MCP", level: 2 },
  { id: "the-manifest", label: "The manifest", level: 2 },
  { id: "server-ids", label: "Server ids and tool names", level: 2 },
  { id: "path-interpolation", label: "Path interpolation", level: 2 },
  { id: "credentials-and-risk", label: "Credentials and risk", level: 2 },
  { id: "lifecycle", label: "Lifecycle", level: 2 },
  { id: "anatomy-of-mcp", label: "Anatomy of an MCP declaration", level: 2 },
  {
    id: "when-to-write-mcp",
    label: "When should my assistant write MCP?",
    level: 2,
  },
];

const linkClass =
  "font-semibold text-emerald-700 underline hover:text-emerald-800";

const TOOLS_PAGE_URL = "/docs/extensibility/tools";
const AGENT_PLUGINS_URL = "https://agent-plugins.org";

type IdRow = {
  plugin: string;
  key: string;
  id: string;
  tools: string;
};

const ID_ROWS: IdRow[] = [
  {
    plugin: "example",
    key: "example",
    id: "example",
    tools: "mcp__example__<tool>",
  },
  {
    plugin: "example-tools",
    key: "search",
    id: "example-tools__search",
    tools: "mcp__example-tools__search__<tool>",
  },
];

export function ExtensibilityMcpContent() {
  return (
    <>
      <DocsContent
        title="MCP servers"
        breadcrumb="Docs / Extensibility / MCP"
        subtitle="Ship MCP servers with a plugin. A root mcp.json declares servers the assistant connects on install, and their tools land in the same catalog as workspace-configured MCP tools."
      >
        <p className="mb-8 text-zinc-600 dark:text-zinc-400">
          This is a declaration, not a TypeScript surface: there is no{" "}
          <code>mcp/</code> directory and nothing to import from{" "}
          <code>@vellumai/plugin-api</code>. The file follows the{" "}
          <Link href={AGENT_PLUGINS_URL} className={linkClass}>
            Agent Plugins 1.0.0
          </Link>{" "}
          MCP schema.
        </p>

        <section id="when-to-ship-mcp">
          <SectionHeading id="when-to-ship-mcp" level={2}>
            When to ship MCP
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Use <code>mcp.json</code> when the capability already exists as an
            MCP server and you want it to come up with the plugin. Prefer a
            native{" "}
            <Link href={TOOLS_PAGE_URL} className={linkClass}>
              plugin tool
            </Link>{" "}
            when you are writing the action yourself: a plugin tool has an
            explicit risk level, a typed <code>execute</code> context, and no
            extra process.
          </p>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            A user can also add MCP servers in settings without a plugin. A
            plugin is what lets you version, install, and distribute those
            servers with the rest of the capability.
          </p>
        </section>

        <section id="the-manifest" className="mt-12">
          <SectionHeading id="the-manifest" level={2}>
            The manifest
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Place <code>mcp.json</code> at the plugin root, next to{" "}
            <code>package.json</code>:
          </p>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "example": { "type": "streamable-http", "url": "https://mcp.example.com" }
  }
}`}</code>
          </pre>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            <code>stdio</code>, <code>sse</code>, and{" "}
            <code>streamable-http</code> transports are supported:
          </p>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`{
  "mcpServers": {
    "local-tools": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@example/mcp-server"],
      "env": { "DATA_DIR": "\${PLUGIN_DATA}" }
    },
    "remote-sse": {
      "type": "sse",
      "url": "https://mcp.example.com/sse"
    }
  }
}`}</code>
          </pre>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            A missing file is skipped. An invalid file disables MCP for that
            plugin only. An invalid individual entry disables only that entry.
            Sibling plugins keep their servers.
          </p>
        </section>

        <section id="server-ids" className="mt-12">
          <SectionHeading id="server-ids" level={2}>
            Server ids and tool names
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Plugin servers share one namespace with workspace MCP servers. The
            assistant qualifies each id with the plugin name, then collapses the
            redundant case:
          </p>
          <div className="mb-4 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left dark:border-zinc-700">
                  <th className="py-2 pr-4 font-semibold text-zinc-900 dark:text-zinc-100">
                    Plugin name
                  </th>
                  <th className="py-2 pr-4 font-semibold text-zinc-900 dark:text-zinc-100">
                    mcp.json key
                  </th>
                  <th className="py-2 pr-4 font-semibold text-zinc-900 dark:text-zinc-100">
                    Server id
                  </th>
                  <th className="py-2 font-semibold text-zinc-900 dark:text-zinc-100">
                    Tool names
                  </th>
                </tr>
              </thead>
              <tbody className="text-zinc-600 dark:text-zinc-400">
                {ID_ROWS.map((row) => (
                  <tr
                    key={`${row.plugin}-${row.key}`}
                    className="border-b border-zinc-100 dark:border-zinc-800"
                  >
                    <td className="py-2 pr-4">
                      <code>{row.plugin}</code>
                    </td>
                    <td className="py-2 pr-4">
                      <code>{row.key}</code>
                    </td>
                    <td className="py-2 pr-4">
                      <code>{row.id}</code>
                    </td>
                    <td className="py-2">
                      <code>{row.tools}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            Two plugins claiming the same id is a skip, not a shadow. The second
            declaration is logged and dropped so the first plugin&apos;s tools
            stay put.
          </p>
        </section>

        <section id="path-interpolation" className="mt-12">
          <SectionHeading id="path-interpolation" level={2}>
            Path interpolation
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            On <code>stdio</code> servers, <code>${"{PLUGIN_ROOT}"}</code> and{" "}
            <code>${"{PLUGIN_DATA}"}</code> interpolate in <code>args</code>,{" "}
            <code>env</code> values, and <code>cwd</code>. They never
            interpolate in <code>command</code>, a URL, or a header, so a
            manifest cannot use them to build the executable path itself.
          </p>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            <code>cwd</code> is accepted by the spec but has no host equivalent.
            It is ignored, with a warning, and the server runs in the
            assistant&apos;s working directory. Put absolute paths in{" "}
            <code>args</code> or <code>env</code> via those variables instead.
          </p>
        </section>

        <section id="credentials-and-risk" className="mt-12">
          <SectionHeading id="credentials-and-risk" level={2}>
            Credentials and risk
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            A plugin cannot ship a credential. The spec defines no portable
            OAuth or credential-reference fields, and any <code>headers</code>{" "}
            in the file are literal package data. Plugin servers also never
            resolve the assistant&apos;s stored <code>mcp:&lt;serverId&gt;:*</code>{" "}
            credentials: a plugin controls both its server key and its URL, so
            honoring them would send a workspace credential to an endpoint the
            plugin chose.
          </p>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            Risk defaults to <code>low</code>, so the tools run without
            prompting under the default auto-approve threshold.{" "}
            <code>mcp.json</code> has no risk field (the spec defines none). The
            review is the marketplace whitelist plus the user&apos;s decision to
            install. A user who wants a different bar sets{" "}
            <code>defaultRiskLevel</code> on a workspace <code>config.json</code>{" "}
            entry of the same id, which outranks the plugin&apos;s declaration
            and replaces it wholesale (transport included). Each server is
            capped at 20 tools (<code>maxTools</code>), the same default a
            workspace MCP entry ships with.
          </p>
        </section>

        <section id="lifecycle" className="mt-12">
          <SectionHeading id="lifecycle" level={2}>
            Lifecycle
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            The assistant connects these servers on start and registers their
            tools alongside workspace-configured ones. Installing, removing,
            upgrading, enabling, or disabling a plugin reconnects the set as
            part of that operation: its servers come up and go down with the
            plugin, no restart involved.
          </p>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            A disabled plugin (<code>.disabled</code> sentinel) contributes no
            MCP servers, matching hooks, tools, and routes. A directory with no
            loadable <code>package.json</code> is ignored even if it has an{" "}
            <code>mcp.json</code>. <code>assistant mcp list</code> shows plugin
            servers with their originating plugin, and{" "}
            <code>status: declared</code> for one the assistant holds no live
            connection to.
          </p>
        </section>

        <section id="anatomy-of-mcp" className="mt-12">
          <SectionHeading id="anatomy-of-mcp" level={2}>
            Anatomy of an MCP declaration
          </SectionHeading>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`example/
├── package.json
├── mcp.json
└── ...`}</code>
          </pre>
          <pre className="mb-0 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "example": {
      "type": "streamable-http",
      "url": "https://mcp.example.com"
    }
  }
}`}</code>
          </pre>
        </section>

        <section id="when-to-write-mcp" className="mt-12">
          <SectionHeading id="when-to-write-mcp" level={2}>
            When should my assistant write MCP?
          </SectionHeading>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            Reach for <code>mcp.json</code> when you are packaging an existing
            MCP server so it installs with the plugin, rather than asking the
            user to paste a URL into settings. If you are implementing the
            action yourself, write a{" "}
            <Link href={TOOLS_PAGE_URL} className={linkClass}>
              plugin tool
            </Link>{" "}
            instead.
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
