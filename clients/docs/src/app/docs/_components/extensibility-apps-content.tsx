"use client";

import Link from "next/link";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "what-an-app-is", label: "What an app is", level: 2 },
  { id: "how-apps-are-addressed", label: "How apps are addressed", level: 2 },
  { id: "serving-and-isolation", label: "Serving and isolation", level: 2 },
  { id: "read-only-over-management", label: "Read-only apps", level: 2 },
  { id: "anatomy-of-an-app", label: "Anatomy of an app", level: 2 },
  {
    id: "when-to-write-an-app",
    label: "When should my assistant write an App?",
    level: 2,
  },
];

const linkClass =
  "font-semibold text-emerald-700 underline hover:text-emerald-800";

const ROUTES_PAGE_URL = "/docs/extensibility/routes";

export function ExtensibilityAppsContent() {
  return (
    <>
      <DocsContent
        title="Apps"
        breadcrumb="Docs / Extensibility / Apps"
        subtitle="Ship a persistent, interactive app (a dashboard, a game, a small tool) that renders in the workspace panel. A plugin can bundle one or more apps alongside its other surfaces."
      >
        <p className="mb-8 text-zinc-600 dark:text-zinc-400">
          An app is a directory under <code>apps/&lt;app&gt;/</code>. Each
          immediate subdirectory of <code>apps/</code> is one app: the directory
          name is the app name, and its contents are the source. Like every
          other surface, a missing <code>apps/</code> directory is simply
          skipped, so a plugin ships an app only if it wants to.
        </p>

        <section id="what-an-app-is">
          <SectionHeading id="what-an-app-is" level={2}>
            What an app is
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Unlike a tool (which the model calls) or a route (which an external
            caller hits), an app is a piece of UI the user opens and interacts
            with directly. It renders in the workspace panel and persists between
            opens.
          </p>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            An app is TSX/React source under <code>src/</code> that compiles to a
            sibling <code>dist/</code>. The bundler (esbuild) maps{" "}
            <code>react</code> / <code>react-dom</code> onto{" "}
            <code>preact/compat</code>, so you write ordinary React components.
            Apps load their scripts from <code>dist/</code>, so they are served
            under a strict Content-Security-Policy (
            <code>script-src &apos;self&apos;</code>, no inline scripts).
          </p>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            The compile happens off the assistant&apos;s hot path: the plugin source
            watcher builds each app&apos;s <code>src/</code> into its sibling{" "}
            <code>dist/</code> when it detects a change, and that generated{" "}
            <code>apps/&lt;app&gt;/dist</code> is excluded from source
            fingerprinting and drift detection (it is build output, not tracked
            source). If an app is opened before its <code>dist/</code> exists, it
            is compiled on demand in a throwaway temporary directory; the
            read-only plugin tree is never written to at open time.
          </p>
        </section>

        <section id="how-apps-are-addressed" className="mt-12">
          <SectionHeading id="how-apps-are-addressed" level={2}>
            How apps are addressed
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            A plugin-bundled app has a deterministic id derived from its
            location, rather than the opaque UUID a user-created workspace app
            gets:
          </p>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`plugins~<plugin-name>~<app-dir>`}</code>
          </pre>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            which maps to{" "}
            <code>
              &lt;workspaceDir&gt;/plugins/&lt;plugin-name&gt;/apps/&lt;app-dir&gt;/
            </code>{" "}
            (the <code>apps/</code> segment is implied). The delimiter is{" "}
            <code>~</code>, a URL-unreserved character, so the whole id is a
            single URL path segment that survives route params and proxies
            without percent-encoding. When an app is opened, the host reports its
            origin as <code>plugin:&lt;plugin-name&gt;</code>, distinguishing it
            from a <code>workspace</code> app.
          </p>
        </section>

        <section id="serving-and-isolation" className="mt-12">
          <SectionHeading id="serving-and-isolation" level={2}>
            Serving and isolation
          </SectionHeading>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            An app is served only for an <em>installed, enabled</em> plugin: the
            plugin directory must exist, carry a <code>package.json</code>{" "}
            manifest, and not be disabled (no <code>.disabled</code> sentinel),
            the same gates the plugin&apos;s other surfaces pass. Asset requests
            are confined to the app directory: a path that tries to traverse out
            of it (<code>../../package.json</code>) is rejected, and an id whose
            segments contain separators or <code>..</code> never resolves to a
            path.
          </p>
        </section>

        <section id="read-only-over-management" className="mt-12">
          <SectionHeading id="read-only-over-management" level={2}>
            Read-only apps
          </SectionHeading>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            A plugin app is part of the plugin&apos;s source tree, so it is
            read-only over the app-management surface: it can be opened and its
            assets served, but it cannot be deleted or have its data mutated
            through the management API the way a user-created workspace app can.
            Its lifecycle is the plugin&apos;s: it arrives on install, updates
            on upgrade, and is removed on uninstall. Any durable state the app
            needs follows the same rule as the rest of the plugin: it lives in
            the plugin&apos;s <code>data/</code> directory, owned by the
            plugin&apos;s lifecycle hooks, not written back into the app source.
          </p>
        </section>

        <section id="anatomy-of-an-app" className="mt-12">
          <SectionHeading id="anatomy-of-an-app" level={2}>
            Anatomy of an app
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            An app is a <code>src/</code> tree that compiles to{" "}
            <code>dist/</code>. A plugin can ship several apps side by side:
          </p>
          <pre className="mb-0 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`my-plugin/
└── apps/
    ├── dashboard/
    │   ├── src/
    │   │   ├── index.html
    │   │   └── main.tsx       # React (preact/compat under the hood)
    │   └── dist/              # generated build output (not tracked source)
    │       ├── index.html
    │       └── main.js
    └── board/
        ├── src/
        │   ├── index.html
        │   └── main.tsx
        └── dist/
            ├── index.html
            └── main.js`}</code>
          </pre>
        </section>

        <section id="when-to-write-an-app" className="mt-12">
          <SectionHeading id="when-to-write-an-app" level={2}>
            When should my assistant write an App?
          </SectionHeading>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            Reach for an app when the assistant needs a <em>surface the user
            looks at and interacts with</em> (a live dashboard, a form, a small
            tool, a game), rather than an action the model invokes or an endpoint
            an external system calls. Pair an app with a{" "}
            <Link href={ROUTES_PAGE_URL} className={linkClass}>
              route
            </Link>{" "}
            when the UI needs a backend it can talk to, and bundle both in one
            plugin so the whole capability ships, versions, and installs
            together. The app reaches those routes through{" "}
            <code>window.vellum.fetch</code> at{" "}
            <code>/x/plugins/&lt;name&gt;/…</code> (the wrapper prepends the{" "}
            <code>/v1</code> API prefix):{" "}
            <strong>
              never the global <code>fetch</code>
            </strong>
            , which fails from the app&apos;s sandboxed origin.
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
