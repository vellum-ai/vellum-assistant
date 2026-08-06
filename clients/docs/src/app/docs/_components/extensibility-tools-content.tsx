"use client";

import Link from "next/link";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "what-a-tool-is", label: "What a tool is", level: 2 },
  { id: "tool-reference", label: "Tool reference", level: 2 },
  { id: "risk-level-and-category", label: "Risk level and category", level: 3 },
  { id: "the-execute-context", label: "The execute context", level: 3 },
  { id: "resolution-order", label: "Resolution order", level: 2 },
  { id: "anatomy-of-a-tool", label: "Anatomy of a tool", level: 2 },
  {
    id: "when-to-write-a-tool",
    label: "When should my assistant write a Tool?",
    level: 2,
  },
];

const linkClass =
  "font-semibold text-emerald-700 underline hover:text-emerald-800";

const PLUGIN_API_URL =
  "https://github.com/vellum-ai/vellum-assistant/tree/main/assistant/src/plugin-api";

type ToolField = {
  name: string;
  type: string;
  fallback: string;
  desc: string;
};

const DEFINITION_FIELDS: ToolField[] = [
  {
    name: "name",
    type: "string",
    fallback: "File basename",
    desc: "Name the model sees when calling the tool. Loaders default to the source file basename, so tools/example.ts becomes example. Only set this to override the file-derived name.",
  },
  {
    name: "description",
    type: "string",
    fallback: '""',
    desc: "Human-readable description shown to the model in the tool catalog. This is how the model decides when to call the tool, so write it for the model.",
  },
  {
    name: "input_schema",
    type: "object (JSON Schema)",
    fallback: "Empty object schema",
    desc: "JSON Schema describing the tool's input arguments. The model is constrained to this shape when it calls the tool.",
  },
  {
    name: "defaultRiskLevel",
    type: '"low" | "medium" | "high"',
    fallback: '"medium"',
    desc: "Author-asserted risk band the gateway weighs against the user's risk tolerance to decide whether a call runs automatically or pauses for approval. Defaults to medium. See Risk level and category below for what each band does.",
  },
  {
    name: "category",
    type: "string",
    fallback: "None",
    desc: "Free-form label a permission policy can allow or block by name via allowedToolCategories. Optional; see Risk level and category below for how to pick one.",
  },
  {
    name: "executionTarget",
    type: '"sandbox" | "host"',
    fallback: "Resolved automatically",
    desc: "Where the tool runs: the sandbox (assistant container) or the host (guardian device, via proxy). When omitted, resolved by name prefix: host_* and computer_use_* default to host, everything else defaults to sandbox.",
  },
  {
    name: "execute",
    type: "(input, ctx) => Promise<ToolExecutionResult>",
    fallback: "Unimplemented error",
    desc: "Implementation invoked when the model calls the tool. When omitted, the loader synthesizes a result that reports the tool as unimplemented.",
  },
];

const CONTEXT_FIELDS: ToolField[] = [
  {
    name: "conversationId",
    type: "string",
    fallback: "",
    desc: "Conversation this tool invocation belongs to.",
  },
  {
    name: "workingDir",
    type: "string",
    fallback: "",
    desc: "Working directory the assistant was launched from.",
  },
  {
    name: "requestId",
    type: "string?",
    fallback: "",
    desc: "Per-turn request id for cross-component log correlation.",
  },
  {
    name: "signal",
    type: "AbortSignal?",
    fallback: "",
    desc: "Cooperative cancellation. Check signal.aborted periodically, or forward it to fetch and child-process options.",
  },
  {
    name: "onOutput",
    type: "(chunk: string) => void?",
    fallback: "",
    desc: "Incremental-output callback for streaming tools. Fall back to returning the full result in content when it is absent.",
  },
  {
    name: "assistantId",
    type: "string?",
    fallback: "",
    desc: "Logical assistant scope for multi-assistant routing.",
  },
  {
    name: "isInteractive",
    type: "boolean?",
    fallback: "",
    desc: "True when an interactive client is connected (not just a no-op callback).",
  },
];

const RESULT_FIELDS: ToolField[] = [
  {
    name: "content",
    type: "string",
    fallback: "",
    desc: "Text result shown to the model in the tool-result block. An empty string is valid.",
  },
  {
    name: "isError",
    type: "boolean",
    fallback: "",
    desc: "When true, the agent loop treats content as an error and may surface it or retry.",
  },
  {
    name: "status",
    type: "string?",
    fallback: "",
    desc: 'Short status message for client display, such as "truncated" or "timed out".',
  },
  {
    name: "yieldToUser",
    type: "boolean?",
    fallback: "",
    desc: "When true, the loop returns control to the user after this result instead of making another model call.",
  },
  {
    name: "contentBlocks",
    type: "ContentBlock[]?",
    fallback: "",
    desc: "Rich content blocks (for example images) to include alongside the text result.",
  },
];

function FieldTable({
  fields,
  fallbackHeader,
}: {
  fields: ToolField[];
  fallbackHeader?: string;
}) {
  return (
    <div className="mb-4 overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-left dark:border-zinc-700">
            <th className="py-2 pr-4 font-semibold text-zinc-900 dark:text-zinc-100">
              Field
            </th>
            <th className="py-2 pr-4 font-semibold text-zinc-900 dark:text-zinc-100">
              Type
            </th>
            {fallbackHeader ? (
              <th className="py-2 pr-4 font-semibold text-zinc-900 dark:text-zinc-100">
                {fallbackHeader}
              </th>
            ) : null}
            <th className="py-2 font-semibold text-zinc-900 dark:text-zinc-100">
              Description
            </th>
          </tr>
        </thead>
        <tbody className="text-zinc-600 dark:text-zinc-400">
          {fields.map((field) => (
            <tr
              key={field.name}
              className="border-b border-zinc-100 align-top dark:border-zinc-800"
            >
              <td className="py-2 pr-4">
                <code>{field.name}</code>
              </td>
              <td className="py-2 pr-4">
                <code className="text-zinc-500 dark:text-zinc-400">
                  {field.type}
                </code>
              </td>
              {fallbackHeader ? (
                <td className="py-2 pr-4">{field.fallback}</td>
              ) : null}
              <td className="py-2">{field.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ExtensibilityToolsContent() {
  return (
    <>
      <DocsContent
        title="Tools"
        breadcrumb="Docs / Extensibility / Tools"
        subtitle="Add new actions the model can call. A plugin tool lands in the same catalog as the Assistant's built-in tools, so the model picks it up with no extra wiring."
      >
        <p className="mb-8 text-zinc-600 dark:text-zinc-400">
          A tool is a default-exported object from{" "}
          <code>tools/&lt;name&gt;.ts</code>. The loader derives the
          model-visible tool name from the file basename, so{" "}
          <code>tools/example.ts</code> becomes the <code>example</code> tool.
          Plugin tools register in the same catalog as built-in tools and are
          offered to the model through the standard tool-calling interface.
        </p>

        <section id="what-a-tool-is">
          <SectionHeading id="what-a-tool-is" level={2}>
            What a tool is
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            A tool is something the model chooses to call. You describe what it
            does and what arguments it takes, and the model decides when to
            invoke it. When it does, the Assistant runs your{" "}
            <code>execute</code> function and feeds the result back into the
            turn.
          </p>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            Every field on a tool definition is optional. The loader fills
            documented defaults for anything you omit, so{" "}
            <code>{"export default {}"}</code> is a valid (if useless) tool. A
            broken or misconfigured tool never blocks the rest of the plugin
            from loading; the problem surfaces at call time instead.
          </p>
        </section>

        <section id="tool-reference" className="mt-12">
          <SectionHeading id="tool-reference" level={2}>
            Tool reference
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            These are the fields a tool definition can set. Names and types come
            from <code>ToolDefinition</code> in{" "}
            <Link href={PLUGIN_API_URL} className={linkClass}>
              <code>@vellumai/plugin-api</code>
            </Link>
            .
          </p>
          <FieldTable fields={DEFINITION_FIELDS} fallbackHeader="Default" />

          <SectionHeading id="risk-level-and-category" level={3}>
            Risk level and category
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Two fields decide whether and where the model is allowed to call
            your tool. <code>defaultRiskLevel</code> gates it against the
            user&apos;s permission settings, and <code>category</code> lets a
            permission policy allow or block it by group. Both are optional, but
            picking them deliberately is what makes a tool feel safe to run
            unattended.
          </p>

          <h4 className="mb-2 mt-6 font-semibold text-zinc-900 dark:text-zinc-100">
            <code>defaultRiskLevel</code>: how risky the call is
          </h4>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            You assert how sensitive the tool&apos;s worst-case action is. The
            gateway compares that band against the user&apos;s configured{" "}
            <em>risk tolerance</em> to decide whether the call auto-approves or
            stops for an approval prompt. The three bands mirror how built-in
            tools are classified:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600 dark:text-zinc-400">
            <li>
              <strong className="text-zinc-900 dark:text-zinc-100">low</strong>{" "}
              covers read-only work with no side effects (reading files,
              searching, recalling memories). At the default risk tolerance
              these auto-approve, so a <code>low</code> tool typically runs with{" "}
              <em>no prompt at all</em>. This is the band that skips the
              confirmation.
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-zinc-100">
                medium
              </strong>{" "}
              covers operations that change state (writing files, calling
              external APIs, running commands that modify things). Whether these
              prompt depends on the user&apos;s tolerance: at the default
              setting they prompt; a user who has raised their tolerance lets
              them through. This is the fallback when you omit the field.
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-zinc-100">high</strong>{" "}
              covers destructive or sensitive actions (deleting data, modifying
              skill source, running <code>sudo</code>). These <em>always</em>{" "}
              prompt, with a red risk badge and the full tool input shown,
              unless the user has explicitly chosen Full access.
            </li>
          </ul>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Set the band to match the most sensitive thing your{" "}
            <code>execute</code> can do. Under-stating it, like tagging a tool
            that writes files as <code>low</code>, means it can run unattended
            for users who have loosened their tolerance, which is exactly the
            case the prompt exists to catch. For the full mapping of bands to
            tolerance thresholds and what each approval prompt looks like, see{" "}
            <Link
              href="/docs/trust-security/the-permissions-model"
              className={linkClass}
            >
              The permissions model
            </Link>
            .
          </p>

          <h4 className="mb-2 mt-6 font-semibold text-zinc-900 dark:text-zinc-100">
            <code>category</code>: which policies may use the tool
          </h4>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            <code>category</code> is a free-form label, any non-empty string,
            not a fixed enum. Its job is tool-policy enforcement: a permission
            policy can list categories under <code>allowedToolCategories</code>,
            and only tools whose <code>category</code> appears in that list are
            offered under that policy. Today that surfaces as per-channel
            permission profiles (see{" "}
            <Link href="/docs/key-concepts/channels" className={linkClass}>
              Channels
            </Link>
            ), where a policy that allows <code>coding</code> admits every tool
            tagged <code>category: &quot;coding&quot;</code> and blocks the
            rest.
          </p>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            So &ldquo;which category?&rdquo; is really &ldquo;how do I want
            policies to group this tool?&rdquo; Pick a short, stable label and
            reuse the same one across related tools, so giving all your
            terminal-style tools <code>category: &quot;terminal&quot;</code>{" "}
            lets a single rule govern them together. Align with the labels
            built-in tools already use (for example <code>coding</code> and{" "}
            <code>terminal</code>) so your tool rides existing rules instead of
            forcing admins to add a new one. If you never scope the tool by
            policy, leave <code>category</code> unset.
          </p>

          <SectionHeading id="the-execute-context" level={3}>
            The execute context
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            <code>execute(input, ctx)</code> receives the model-supplied{" "}
            <code>input</code> (validated against your <code>input_schema</code>
            ) and a <code>ToolContext</code>, and returns a{" "}
            <code>ToolExecutionResult</code>. The stable{" "}
            <code>ToolContext</code> surface a plugin tool should rely on is
            listed below. The host threads additional routing, permission, and
            trust metadata onto the context, but those fields are internal and
            still being narrowed while plugins are in beta, so don&apos;t depend
            on them.
          </p>
          <FieldTable fields={CONTEXT_FIELDS} />
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            And the result is what the model sees back:
          </p>
          <FieldTable fields={RESULT_FIELDS} />
        </section>

        <section id="resolution-order" className="mt-12">
          <SectionHeading id="resolution-order" level={2}>
            Resolution order
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            All tools (built-in, plugin, workspace, and MCP) land in one shared
            catalog. When the model calls a tool, the runtime looks it up by
            name. When two sources register the same name, the higher-precedence
            source wins:
          </p>
          <ol className="mb-4 list-decimal space-y-2 pl-6 text-zinc-600 dark:text-zinc-400">
            <li>
              <strong className="text-zinc-900 dark:text-zinc-100">
                Core tools
              </strong>
              . Registered at startup. They take precedence over plugin and MCP
              tools: a plugin or MCP tool with the same name is skipped with a
              warning.
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-zinc-100">
                Workspace tools
              </strong>
              . Filesystem overrides under <code>/workspace/tools/</code>. These
              are the explicit exception to registration order: a workspace
              override always shadows a core tool of the same name, regardless
              of when it was discovered.
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-zinc-100">
                MCP server tools
              </strong>
              . Registered when an MCP server connects. Conflicts with core or
              workspace tools are skipped; conflicts with plugin tools are
              resolved by first registration.
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-zinc-100">
                Built-in default plugin tools
              </strong>
              . Vellum ships a set of default plugins alongside the Assistant.
              Their tools register during bootstrap, before any user-installed
              plugin tools.
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-zinc-100">
                User plugin tools
              </strong>
              . Registered at boot, ordered by the plugin&apos;s original
              install date (same ordering as hooks:{" "}
              <code>install-meta.json</code> &rarr; directory birthtime &rarr;
              unknown). A user plugin tool that collides with a core, workspace,
              MCP, or default plugin tool is skipped. A collision between two
              different user plugins with the same tool name fails registration.
            </li>
          </ol>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            The model sees the full catalog regardless of source. Pick
            distinctive tool names to avoid collisions. The loader derives the
            name from the file basename, so namespacing with a prefix (for
            example <code>myplugin_search</code>) is the simplest way to stay
            clear.
          </p>
        </section>

        <section id="anatomy-of-a-tool" className="mt-12">
          <SectionHeading id="anatomy-of-a-tool" level={2}>
            Anatomy of a tool
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            One tool per file, default-exported. The filename becomes the tool
            name, so an <code>example</code> tool is{" "}
            <code>tools/example.ts</code>:
          </p>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`// tools/example.ts
import type { ToolContext, ToolExecutionResult } from "@vellumai/plugin-api";

export default {
  description:
    "Search saved notes for a phrase. Use this when the user asks what they told you to remember.",
  defaultRiskLevel: "low" as const,
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Text to search for." },
    },
    required: ["query"],
  },
  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolExecutionResult> {
    const query = String((input as { query?: unknown }).query ?? "").trim();
    if (query.length === 0) {
      return { content: "error: query must be non-empty", isError: true };
    }
    // ctx.conversationId - current conversation
    // ctx.signal         - forward to fetch() / spawn() for cancellation
    return { content: \`searched \${ctx.conversationId} for \${query}\`, isError: false };
  },
};`}</code>
          </pre>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            Types come from{" "}
            <Link href={PLUGIN_API_URL} className={linkClass}>
              <code>@vellumai/plugin-api</code>
            </Link>
            , the only supported contract.
          </p>
        </section>

        <section id="when-to-write-a-tool" className="mt-12">
          <SectionHeading id="when-to-write-a-tool" level={2}>
            When should my assistant write a Tool?
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Reach for a tool when the assistant needs to <em>do</em> something
            the model invokes by name and gets a result back: call an API, run a
            query, compute a value, return structured data. A tool is a typed
            action in the catalog. The model decides when to call it, and the
            result flows into the turn.
          </p>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            A tool is <em>always</em> loaded in the model&apos;s context: its
            name, description, and input schema sit in the catalog the model
            sees on every request, so the assistant pays that token cost whether
            or not the tool is ever called. Add tools the assistant reaches for
            often, and keep their descriptions and schemas tight. For a
            capability that is only occasionally relevant, prefer something the
            model pulls in on demand so it does not weigh on every turn.
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
