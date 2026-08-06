"use client";

import Link from "next/link";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "where-routes-are-served", label: "Where routes are served", level: 2 },
  { id: "path-mapping", label: "Path mapping", level: 2 },
  { id: "writing-a-handler", label: "Writing a handler", level: 2 },
  { id: "loading-and-lifecycle", label: "Loading and lifecycle", level: 2 },
  { id: "anatomy-of-a-route", label: "Anatomy of a route", level: 2 },
  {
    id: "calling-from-an-app",
    label: "Calling a route from an app frontend",
    level: 2,
  },
  {
    id: "when-to-write-a-route",
    label: "When should my assistant write a Route?",
    level: 2,
  },
];

const linkClass =
  "font-semibold text-emerald-700 underline hover:text-emerald-800";

const APPS_PAGE_URL = "/docs/extensibility/apps";

const PLUGIN_API_URL =
  "https://github.com/vellum-ai/vellum-assistant/tree/main/assistant/src/plugin-api";

type PathRow = { file: string; served: string };

const PATH_ROWS: PathRow[] = [
  { file: "routes/status.ts", served: "/x/plugins/<name>/status" },
  {
    file: "routes/webhooks/incoming.ts",
    served: "/x/plugins/<name>/webhooks/incoming",
  },
  { file: "routes/index.ts", served: "/x/plugins/<name> (the namespace root)" },
];

export function ExtensibilityRoutesContent() {
  return (
    <>
      <DocsContent
        title="Routes"
        breadcrumb="Docs / Extensibility / Routes"
        subtitle="Expose HTTP endpoints from a plugin. A route lets external systems (webhooks, integrations, callbacks, small tools) reach the Assistant over HTTP inside the plugin's own namespace."
      >
        <p className="mb-8 text-zinc-600 dark:text-zinc-400">
          A route is a file under <code>routes/&lt;path&gt;.ts</code> that
          exports named HTTP-method functions. There is no registration step and
          no manifest entry: the Assistant&apos;s <code>/x/*</code> route
          dispatcher resolves each request against the plugin&apos;s{" "}
          <code>routes/</code> directory on disk at request time.
        </p>

        <section id="where-routes-are-served">
          <SectionHeading id="where-routes-are-served" level={2}>
            Where routes are served
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Every plugin route lives in a namespace reserved for that plugin:
          </p>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`/x/plugins/<plugin-name>/<path>`}</code>
          </pre>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            The <code>plugins/&lt;name&gt;/</code> prefix resolves{" "}
            <strong>only</strong> against{" "}
            <code>&lt;workspaceDir&gt;/plugins/&lt;name&gt;/routes/</code>. It
            never falls back to a workspace <code>routes/plugins/…</code> file,
            so a plugin can&apos;t collide with workspace routes or with another
            plugin. A path with no matching file returns 404, and a disabled
            plugin (its <code>.disabled</code> sentinel present) serves no routes
            even though the files remain on disk.
          </p>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            The same file-based dispatcher also serves standalone workspace
            routes at <code>/x/&lt;path&gt;</code> from{" "}
            <code>&lt;workspaceDir&gt;/routes/</code>. Plugin routes are the
            namespaced form of that surface; a plugin is what lets you ship
            routes together with its other surfaces as one installable unit.
          </p>
        </section>

        <section id="path-mapping" className="mt-12">
          <SectionHeading id="path-mapping" level={2}>
            Path mapping
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            The file&apos;s path under <code>routes/</code> becomes the sub-path,
            minus the extension. Nested directories nest, and an{" "}
            <code>index</code> file maps to the directory itself:
          </p>
          <div className="mb-4 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left dark:border-zinc-700">
                  <th className="py-2 pr-4 font-semibold text-zinc-900 dark:text-zinc-100">
                    File
                  </th>
                  <th className="py-2 font-semibold text-zinc-900 dark:text-zinc-100">
                    Served at
                  </th>
                </tr>
              </thead>
              <tbody className="text-zinc-600 dark:text-zinc-400">
                {PATH_ROWS.map((row) => (
                  <tr
                    key={row.file}
                    className="border-b border-zinc-100 align-top dark:border-zinc-800"
                  >
                    <td className="py-2 pr-4">
                      <code>{row.file}</code>
                    </td>
                    <td className="py-2">
                      <code>{row.served}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            <code>.js</code> wins over <code>.ts</code> for the same basename
            (compiled-binary semantics), and a direct file wins over an{" "}
            <code>index</code> file for the same path.
          </p>
        </section>

        <section id="writing-a-handler" className="mt-12">
          <SectionHeading id="writing-a-handler" level={2}>
            Writing a handler
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Each file exports one function per HTTP method it accepts (
            <code>GET</code>, <code>POST</code>, <code>PUT</code>,{" "}
            <code>PATCH</code>, <code>DELETE</code>, <code>HEAD</code>,{" "}
            <code>OPTIONS</code>), using the standard Web API{" "}
            <code>Request</code>/<code>Response</code> signature. A request whose
            method the file does not export returns 405 with an{" "}
            <code>Allow</code> header listing the methods it does.
          </p>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`export async function GET(request: Request): Promise<Response> {
  return Response.json({ ok: true });
}

export async function POST(request: Request): Promise<Response> {
  const body = await request.json();
  return Response.json({ received: body }, { status: 201 });
}`}</code>
          </pre>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Handlers receive a second <code>context</code> argument with the
            Assistant&apos;s runtime singletons (the event hub, and a{" "}
            <code>conversations.postMessage</code> helper for surfacing an
            inbound event as a real turn):
          </p>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`export async function POST(request: Request, context): Promise<Response> {
  const { conversationId, text } = await request.json();
  await context.conversations.postMessage(conversationId, text);
  return Response.json({ delivered: true });
}`}</code>
          </pre>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            A handler may also reach other Assistant capabilities through its{" "}
            <Link href={PLUGIN_API_URL} className={linkClass}>
              <code>@vellumai/plugin-api</code>
            </Link>{" "}
            imports, the same as any other surface.
          </p>
        </section>

        <section id="loading-and-lifecycle" className="mt-12">
          <SectionHeading id="loading-and-lifecycle" level={2}>
            Loading and lifecycle
          </SectionHeading>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            Route files are loaded lazily on the first matching request and
            cached by path + mtime. Editing a route file is picked up on the next
            request; the dispatcher re-reads it when its mtime changes, so there
            is no restart or reload step. A handler that throws returns 500; a
            handler that runs longer than the per-request timeout (30s) returns
            504.
          </p>
        </section>

        <section id="anatomy-of-a-route" className="mt-12">
          <SectionHeading id="anatomy-of-a-route" level={2}>
            Anatomy of a route
          </SectionHeading>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`my-plugin/
└── routes/
    ├── index.ts          → GET /x/plugins/my-plugin
    ├── status.ts         → GET, POST /x/plugins/my-plugin/status
    └── webhooks/
        └── incoming.ts   → POST /x/plugins/my-plugin/webhooks/incoming`}</code>
          </pre>
          <pre className="mb-0 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`// routes/status.ts
export async function GET(request: Request): Promise<Response> {
  return Response.json({ status: "ok", uptimeMs: performance.now() });
}`}</code>
          </pre>
        </section>

        <section id="calling-from-an-app" className="mt-12">
          <SectionHeading id="calling-from-an-app" level={2}>
            Calling a route from an app frontend
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            A plugin{" "}
            <Link href={APPS_PAGE_URL} className={linkClass}>
              app
            </Link>{" "}
            that backs its data with the plugin&apos;s own routes must reach
            them through the <code>window.vellum.fetch</code> bridge —{" "}
            <strong>
              never the global <code>fetch</code>
            </strong>
            . An app runs in a sandboxed origin, so a raw <code>fetch</code>{" "}
            carries no gateway URL and no auth headers and the request fails;{" "}
            <code>window.vellum.fetch</code> injects both and routes the call to
            the Assistant runtime.
          </p>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Call the route at the same path it is served —{" "}
            <code>/x/plugins/&lt;name&gt;/&lt;path&gt;</code>. The wrapper
            prepends the <code>/v1</code> API prefix for you, so you never write
            it:
          </p>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`// inside apps/<app>/src — calling this plugin's own status route
const res = await window.vellum.fetch("/x/plugins/my-plugin/status");
if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
const data = await res.json();`}</code>
          </pre>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            Webhooks and other external callers reach the same route over plain
            HTTP; the <code>window.vellum.fetch</code> rule is specific to an app
            frontend&apos;s sandboxed origin.
          </p>
        </section>

        <section id="when-to-write-a-route" className="mt-12">
          <SectionHeading id="when-to-write-a-route" level={2}>
            When should my assistant write a Route?
          </SectionHeading>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            Reach for a route when something <em>outside</em> the assistant needs
            to reach <em>in</em> over HTTP: a webhook from a third-party service,
            an OAuth callback, an integration that posts events, or a small
            status endpoint. Unlike a tool (which the model calls) or a hook
            (which fires inside the turn), a route is driven by an external
            caller and runs whenever a request arrives. Bundle it in a plugin
            when you want that endpoint to ship, version, and install alongside
            the plugin&apos;s other surfaces.
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
