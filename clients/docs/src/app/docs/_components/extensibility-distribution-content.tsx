"use client";

import Link from "next/link";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "the-catalog", label: "The marketplace catalog", level: 2 },
  { id: "publishing", label: "Publishing your plugin", level: 2 },
  { id: "installing", label: "Installing a plugin", level: 2 },
  { id: "the-cli", label: "The plugins CLI", level: 3 },
  { id: "untrusted-install", label: "Installing from a GitHub URL (untrusted)", level: 2 },
  { id: "updating", label: "Updating a plugin", level: 2 },
  { id: "drift", label: "Drift and local edits", level: 3 },
  { id: "in-product", label: "Upgrading from the Plugins tab", level: 3 },
  { id: "the-manifest", label: "The marketplace manifest", level: 2 },
  { id: "commit-pinning", label: "Why entries pin a commit", level: 2 },
  { id: "adapters", label: "Adapting external plugins", level: 2 },
];

const linkClass =
  "font-semibold text-emerald-700 underline hover:text-emerald-800";

const MARKETPLACE_URL =
  "https://github.com/vellum-ai/vellum-assistant/blob/main/plugins/marketplace.json";

const CLAUDE_MARKETPLACE_URL =
  "https://code.claude.com/docs/en/plugin-marketplaces";

const PLUGINS_PAGE_URL = "/docs/extensibility/plugins";

type ManifestField = {
  name: string;
  type: string;
  required: string;
  desc: string;
};

const MANIFEST_FIELDS: ManifestField[] = [
  {
    name: "name",
    type: "string",
    required: "Required",
    desc: "The install name. assistant plugins install <name> resolves to this entry, and the name must be a single kebab-case segment.",
  },
  {
    name: "source.source",
    type: '"github"',
    required: "Required",
    desc: "Source kind. Only github sources are resolved today.",
  },
  {
    name: "source.repo",
    type: "string",
    required: "Required",
    desc: "owner/repo of the external repository to fetch from.",
  },
  {
    name: "source.ref",
    type: "string",
    required: "Required",
    desc: "The full commit SHA (40 or 64 hex chars) to fetch. Tags and branches are rejected.",
  },
  {
    name: "source.path",
    type: "string",
    required: "Optional",
    desc: "Directory within the repo holding the plugin root. Omit for the repository root; .. segments are rejected.",
  },
  {
    name: "description",
    type: "string",
    required: "Optional",
    desc: "Short summary shown in the catalog.",
  },
  {
    name: "category",
    type: "string",
    required: "Optional",
    desc: "Grouping label surfaced in the catalog.",
  },
  {
    name: "homepage",
    type: "string",
    required: "Optional",
    desc: "Link to the plugin's home, surfaced in the catalog.",
  },
  {
    name: "license",
    type: "string",
    required: "Optional",
    desc: "Informational license identifier, surfaced where present.",
  },
];

type CliCommand = {
  command: string;
  signature: string;
  summary: string;
  options: { flag: string; desc: string }[];
  note?: string;
};

const CLI_COMMANDS: CliCommand[] = [
  {
    command: "search",
    signature: "assistant plugins search <query>",
    summary:
      "Search the catalog for plugin names matching <query> (a case-insensitive regex) and print each match with its source path.",
    options: [
      {
        flag: "--json",
        desc: "Emit machine-readable JSON instead of a table.",
      },
    ],
  },
  {
    command: "install",
    signature: "assistant plugins install <name-or-url>",
    summary:
      "Resolve <name> in the catalog, shallow-clone its repo at the pinned commit, and materialize it under <workspaceDir>/plugins/<name>/. The resolved commit is recorded for provenance. Or pass a GitHub URL (or owner/repo shorthand) to install directly from an untrusted source, bypassing the catalog.",
    options: [
      {
        flag: "--force",
        desc: "Overwrite an existing install of the same name.",
      },
      {
        flag: "--ref <ref>",
        desc: "Advanced. Read the catalog (and any adapter stub) from a different ref of the vellum-assistant repo; defaults to main. The external plugin itself is still fetched at the commit pinned in the manifest, never this ref. Marketplace installs only; for a GitHub URL, put the ref in the URL (.../tree/<ref>/...).",
      },
      {
        flag: "--pin <sha>",
        desc: "Install a specific reviewed marketplace pin (full commit SHA); run plugins versions <name> to list them. Marketplace installs only.",
      },
      {
        flag: "--allow-unreviewed",
        desc: "With --pin, install a SHA that is not in the reviewed marketplace history (advanced; the curated adapter may not match). Marketplace installs only.",
      },
      {
        flag: "--name <name>",
        desc: "Install directory name for a GitHub-URL install (default: derived from the repo or sub-path leaf). Ignored for marketplace installs.",
      },
    ],
    note: "Installs are hot-loaded, and all surfaces should be picked up automatically.",
  },
  {
    command: "list",
    signature: "assistant plugins list",
    summary:
      "List the plugins installed under <workspaceDir>/plugins/, with each one's version and load status.",
    options: [
      {
        flag: "--json",
        desc: "Emit machine-readable JSON instead of a table.",
      },
    ],
  },
  {
    command: "inspect",
    signature: "assistant plugins inspect <name>",
    summary:
      "Show the installed copy's provenance (commit timestamp, hash, and location) alongside the marketplace's current pin, and classify whether an update is available. Also reports whether the on-disk files have local edits relative to the install-time fingerprint.",
    options: [
      {
        flag: "--json",
        desc: "Emit machine-readable JSON instead of a summary.",
      },
    ],
  },
  {
    command: "upgrade",
    signature: "assistant plugins upgrade <name>",
    summary:
      "Move an installed plugin to the marketplace's current pinned commit. It is a no-op when the install already matches the pin, and mechanically a forced re-install at the new commit (the old copy is kept until the fetch succeeds).",
    options: [
      {
        flag: "--dry-run",
        desc: "Report the commit move without touching the install.",
      },
      {
        flag: "--json",
        desc: "Emit machine-readable JSON instead of a summary.",
      },
    ],
    note: "Upgrading re-installs at the new commit and overwrites any local edits to the plugin's source files. Preserved entries (config.json, data/, .disabled) are carried over to the new install, so user config and runtime data survive upgrades. The upgraded code is picked up immediately for each surface.",
  },
  {
    command: "uninstall",
    signature: "assistant plugins uninstall <name>",
    summary:
      "Remove <workspaceDir>/plugins/<name>/. Prompts for confirmation unless stdin is non-interactive. The entire plugin directory is removed, including config.json and data/, so no orphaned state is left behind.",
    options: [{ flag: "--force", desc: "Skip the confirmation prompt." }],
    note: "The plugin is dropped immediately.",
  },
];

function ManifestTable({ fields }: { fields: ManifestField[] }) {
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
            <th className="py-2 pr-4 font-semibold text-zinc-900 dark:text-zinc-100">
              Required
            </th>
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
              <td className="py-2 pr-4 whitespace-nowrap">{field.required}</td>
              <td className="py-2">{field.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ExtensibilityDistributionContent() {
  return (
    <>
      <DocsContent
        title="Distribution"
        breadcrumb="Docs / Extensibility / Distribution"
        subtitle="Plugins ship through a curated marketplace and install by name from the CLI. This page covers the catalog, the install flow, installing directly from a GitHub URL, and the manifest that lists every installable plugin."
      >
        <p className="mb-8 text-zinc-600 dark:text-zinc-400">
          A plugin does not have to live in your workspace to be installed.
          Vellum keeps a curated catalog of external plugins, and the CLI
          installs any of them by name. The catalog is a single manifest the
          Vellum team reviews and approves, so installing a catalog plugin
          only ever pulls code that has been vetted into that list. For
          plugins not yet in the catalog, the CLI also accepts a GitHub URL
          directly, see{" "}
          <Link href="#untrusted-install" className={linkClass}>
            Installing from a GitHub URL (untrusted)
          </Link>
          .
        </p>

        <section id="the-catalog">
          <SectionHeading id="the-catalog" level={2}>
            The marketplace catalog
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            The catalog is computed live from{" "}
            <Link href={MARKETPLACE_URL} className={linkClass}>
              <code>plugins/marketplace.json</code>
            </Link>{" "}
            in the assistant repo. It lets Vellum surface plugins that live in
            other repositories without copying their code, and its shape is a
            subset of the{" "}
            <Link href={CLAUDE_MARKETPLACE_URL} className={linkClass}>
              Claude Code marketplace schema
            </Link>
            , so the format is familiar if you have published there.
          </p>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600 dark:text-zinc-400">
            <li>
              <strong className="text-zinc-900 dark:text-zinc-100">
                Curation is the allowlist.
              </strong>{" "}
              Only repositories listed in the manifest appear in the catalog.
              There is no open registry, and the Vellum team reviews each entry
              before it lands.
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-zinc-100">
                The manifest is the catalog.
              </strong>{" "}
              It is the sole source of installable plugins. A missing or
              malformed manifest yields an empty catalog rather than falling
              back to anything else.
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-zinc-100">
                One surface, two clients.
              </strong>{" "}
              The same catalog backs <code>assistant plugins search</code> and
              the in-product Plugins tab.
            </li>
          </ul>
        </section>

        <section id="publishing" className="mt-12">
          <SectionHeading id="publishing" level={2}>
            Publishing your plugin
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Once your plugin works locally, you can list it in the marketplace
            catalog so anyone can install it by name. The catalog is a curated
            allowlist: you open a PR adding an entry, the Vellum team reviews
            it, and once merged the plugin is discoverable via{" "}
            <code>assistant plugins search</code> and installable via{" "}
            <code>assistant plugins install</code>.
          </p>

          <SectionHeading id="publish-push" level={3}>
            1. Push your plugin to a public GitHub repo
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            The marketplace resolves plugins from GitHub repositories. Push your
            plugin to a public repo, then note the full commit SHA you want to
            pin:
          </p>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`# Get the full 40-char commit SHA of the revision to publish
$ git rev-parse HEAD
e83c5163316f89bfbde7d9ab23ca2e25604af290`}</code>
          </pre>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            The SHA must be a full commit hash (40 or 64 hex chars). Tags and
            branches are rejected because they are mutable. If you want to pin a
            release tag, resolve it to the underlying commit first (see{" "}
            <Link href="#commit-pinning" className={linkClass}>
              Why entries pin a commit
            </Link>{" "}
            below). Your plugin can live at the root of its own repo or in a
            subdirectory. If it is not at the root, use <code>source.path</code>{" "}
            to point at the subdirectory.
          </p>

          <SectionHeading id="publish-add-entry" level={3}>
            2. Add your entry to marketplace.json
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Open a PR against{" "}
            <Link
              href="https://github.com/vellum-ai/vellum-assistant"
              className={linkClass}
            >
              <code>vellum-ai/vellum-assistant</code>
            </Link>{" "}
            adding your plugin to <code>plugins/marketplace.json</code>. Copy
            this template and fill in your details:
          </p>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`{
"name": "my-plugin",
"source": {
  "source": "github",
  "repo": "you/my-plugin",
  "ref": "e83c5163316f89bfbde7d9ab23ca2e25604af290"
},
"description": "One-line summary shown in the catalog.",
"category": "productivity",
"homepage": "https://github.com/you/my-plugin",
"license": "MIT"
}`}</code>
          </pre>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            The <code>name</code> must be a single kebab-case segment (e.g.{" "}
            <code>my-plugin</code>, not <code>myPlugin</code> or{" "}
            <code>my_plugin</code>). Only <code>name</code>,{" "}
            <code>source.source</code>, <code>source.repo</code>, and{" "}
            <code>source.ref</code> are required; the rest are optional but
            recommended for discoverability. See{" "}
            <Link href="#the-manifest" className={linkClass}>
              The marketplace manifest
            </Link>{" "}
            below for the full schema.
          </p>

          <SectionHeading id="publish-review" level={3}>
            3. Wait for review
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            The Vellum team reviews each entry before it lands in the catalog.
            The review checks that:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600 dark:text-zinc-400">
            <li>
              The pinned commit matches a public, reachable revision of the
              repo.
            </li>
            <li>
              The plugin has a valid <code>package.json</code> with a{" "}
              <code>@vellumai/plugin-api</code> peer dependency.
            </li>
            <li>
              The plugin loads cleanly (hooks register, tools validate, no
              import errors at boot).
            </li>
            <li>
              The surfaces the plugin claims contribute something on boot
              rather than silently failing.
            </li>
          </ul>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            Once the review approves and the PR merges, the plugin appears in{" "}
            <code>assistant plugins search</code> and is installable by name.
          </p>
        </section>

        <section id="installing" className="mt-12">
          <SectionHeading id="installing" level={2}>
            Installing a plugin
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Install by name. The CLI resolves the entry, shallow-clones the
            repository at its pinned commit, and writes the plugin into your
            workspace where the loader discovers it on the next start.
          </p>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`# Find a plugin in the catalog
$ assistant plugins search memory
NAME           PATH
simple-memory  vellum-ai/simple-memory

# Install it by name (clones the pinned commit)
$ assistant plugins install simple-memory
Installed plugin "simple-memory" (12 files) at ed09a4c → ~/.vellum/workspace/plugins/simple-memory
The new plugin is picked up automatically.

# Confirm what is installed
$ assistant plugins list
NAME           VERSION  STATUS
simple-memory  0.1.0    ok`}</code>
          </pre>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            The plugins command group is gated behind a beta feature flag while
            the install path stabilizes. Once installed, a plugin is just a
            directory in your workspace, so everything on the{" "}
            <Link href={PLUGINS_PAGE_URL} className={linkClass}>
              Plugins
            </Link>{" "}
            page applies to it.
          </p>

          <SectionHeading id="the-cli" level={3}>
            The plugins CLI
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Six subcommands cover the lifecycle. Expand one to see its options
            and behavior.
          </p>
          <div className="mb-4">
            {CLI_COMMANDS.map((cmd) => (
              <details
                key={cmd.command}
                className="mb-3 rounded-lg border border-zinc-200 dark:border-zinc-700"
              >
                <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-sm">
                  <code className="font-semibold text-zinc-900 dark:text-zinc-100">
                    plugins {cmd.command}
                  </code>
                  <span className="font-mono text-xs text-zinc-400 dark:text-zinc-500">
                    {cmd.signature}
                  </span>
                </summary>
                <div className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-700">
                  <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
                    {cmd.summary}
                  </p>
                  <ul className="mb-0 list-disc space-y-2 pl-6 text-sm text-zinc-600 dark:text-zinc-400">
                    {cmd.options.map((opt) => (
                      <li key={opt.flag}>
                        <code className="text-zinc-900 dark:text-zinc-100">
                          {opt.flag}
                        </code>
                        : {opt.desc}
                      </li>
                    ))}
                  </ul>
                  {cmd.note ? (
                    <p className="mt-3 mb-0 text-sm text-zinc-600 dark:text-zinc-400">
                      <strong className="text-zinc-900 dark:text-zinc-100">
                        Note:
                      </strong>{" "}
                      {cmd.note}
                    </p>
                  ) : null}
                </div>
              </details>
            ))}
          </div>
        </section>

        <section id="untrusted-install" className="mt-12">
          <SectionHeading id="untrusted-install" level={2}>
            Installing from a GitHub URL (untrusted)
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            While a plugin is still under development, before it is whitelisted
            in the catalog, you can install it directly from its GitHub repo
            by passing a URL (anything containing a slash) instead of a
            marketplace name:
          </p>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`# Install from a repo URL (default branch)
$ assistant plugins install https://github.com/owner/repo
⚠ Installing "repo" from an unreviewed GitHub source: owner/repo @ default branch.
 This plugin is NOT in the Vellum marketplace and has not been reviewed.
 Its hooks and tools run inside the assistant with full access — install it only if you trust the source.
Installed untrusted plugin "repo" (8 files) → ~/.vellum/workspace/plugins/repo

# Install from a specific branch and sub-path
$ assistant plugins install https://github.com/owner/repo/tree/my-branch/packages/cool-plugin

# Install with a custom name
$ assistant plugins install owner/repo --name my-plugin --force

# Shorthand: owner/repo works without the full URL
$ assistant plugins install owner/repo`}</code>
          </pre>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            The ref comes from the URL&apos;s{" "}
            <code>/tree/&lt;ref&gt;/</code> segment, or defaults to the
            repository&apos;s default branch. The install directory name is
            derived from the repo (or sub-path leaf) and can be overridden with{" "}
            <code>--name</code>.
          </p>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            A direct install <strong>bypasses marketplace curation
            entirely</strong>:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600 dark:text-zinc-400">
            <li>
              The tree is materialized verbatim. No{" "}
              <Link href="#adapters" className={linkClass}>
                postinstall adapter
              </Link>{" "}
              stub is overlaid, so a plugin authored for another ecosystem may
              install but contribute nothing on boot.
            </li>
            <li>
              The source is <strong>untrusted</strong>. It has not been
              reviewed, and its hooks and tools run inside the assistant with
              full access. The CLI prints a yellow warning naming the source
              so the choice to trust it is explicit.
            </li>
            <li>
              Unlike marketplace installs, which pin an immutable, reviewed
              commit SHA, a branch or <code>HEAD</code> ref is mutable. A
              direct install is a development convenience, not a reproducible
              pin. If you pin a full commit SHA in the URL, the integrity
              check still enforces it.
            </li>
            <li>
              The marketplace-only flags (<code>--ref</code>,{" "}
              <code>--pin</code>, <code>--allow-unreviewed</code>) do not
              apply to a direct install. The ref lives in the URL.
            </li>
          </ul>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            Once the plugin is ready for broader distribution, add it to{" "}
            <code>marketplace.json</code> so others can install it by name
            with a reviewed, reproducible pin.
          </p>
        </section>

        <section id="updating" className="mt-12">
          <SectionHeading id="updating" level={2}>
            Updating a plugin
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Installs are pinned. Because the catalog pins each plugin to an
            immutable commit, an install never changes on its own. It stays on
            the commit it was installed at until you explicitly move it.
            Curators advance a plugin by bumping its <code>source.ref</code> in
            the manifest; your local copy only catches up when you upgrade it.
          </p>

          <SectionHeading id="drift" level={3}>
            Drift and local edits
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Every install records its provenance (the resolved commit, the
            commit&apos;s timestamp, and a per-file fingerprint of the
            materialized tree) in an <code>install-meta.json</code> sidecar at
            the plugin root. The fingerprint excludes four preserved entries (
            <code>install-meta.json</code>, <code>config.json</code>,{" "}
            <code>data/</code>, <code>.disabled</code>) so user config edits and
            runtime data never show as drift. <code>assistant plugins inspect &lt;name&gt;</code>{" "}
            reads that sidecar, compares the installed commit against the
            marketplace&apos;s current pin, and reports one of six states:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600 dark:text-zinc-400">
            <li>
              <code>up-to-date</code>: the installed commit matches the pin.
            </li>
            <li>
              <code>update-available</code>: the pin has moved past the
              installed commit.
            </li>
            <li>
              <code>not-installed</code>: nothing is installed under that name.
            </li>
            <li>
              <code>not-in-marketplace</code>: installed, but the catalog has no
              entry to compare against.
            </li>
            <li>
              <code>unknown-provenance</code>: installed without a recorded
              commit (an older or manually-copied install); reinstall to record
              one.
            </li>
            <li>
              <code>remote-unavailable</code>: the catalog could not be reached
              to resolve the pin.
            </li>
          </ul>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Inspect leads with each side&apos;s commit{" "}
            <strong>timestamp</strong> as the human-readable version (the
            commit&apos;s committer date, so the installed and remote lines are
            directly comparable), with the commit hash shown as a secondary
            detail. It also recomputes the fingerprint against the on-disk files
            and reports <strong>drift</strong>: how many files were modified,
            added, or removed since install. This is a one-way signal that
            detects the working copy diverged, which matters because upgrading
            re-installs at the new commit and overwrites those edits.
          </p>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`# Check whether an install is behind the pin
$ assistant plugins inspect simple-memory
simple-memory
────────────────────────────────────────────
status      update available
installed
  timestamp 2026-06-01T12:34:56
  hash      ed09a4c
  location  /workspace/plugins/simple-memory
  updated   2026-06-01T12:35:10
drift       none
remote
  timestamp 2026-06-05T08:12:24
  hash      3eae182
  location  https://github.com/vellum-ai/simple-memory

# Preview the move, then upgrade to the current pin
$ assistant plugins upgrade simple-memory --dry-run
"simple-memory" would upgrade 2026-06-01T12:34:56 (ed09a4c) → 2026-06-05T08:12:24 (3eae182)

dry run; no changes made.

$ assistant plugins upgrade simple-memory
Upgraded "simple-memory" 2026-06-01T12:34:56 (ed09a4c) → 2026-06-05T08:12:24 (3eae182)

(12 files) → /workspace/plugins/simple-memory`}</code>
          </pre>

          <SectionHeading id="in-product" level={3}>
            Upgrading from the Plugins tab
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            The same drift check backs the in-product Plugins tab, so you do not
            have to drop to the CLI to stay current. When an installed plugin is
            behind the pin, its row shows an <strong>Update available</strong>{" "}
            badge and its detail page surfaces an <strong>Upgrade</strong>{" "}
            button that moves the install to the current pin and reloads the
            list.
          </p>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            If inspect reports local edits, the Upgrade button first asks you to
            confirm, since the upgrade will overwrite those changes. The button
            stays hidden whenever there is nothing to upgrade: an up-to-date
            install, a plugin not in the catalog, or an assistant too old to
            expose the drift check.
          </p>
        </section>

        <section id="the-manifest" className="mt-12">
          <SectionHeading id="the-manifest" level={2}>
            The marketplace manifest
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            The manifest has a top-level <code>name</code>, an optional{" "}
            <code>owner</code>, and a <code>plugins</code> array. Each entry
            names the plugin and points at the exact source revision to install.
          </p>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`{
  "name": "vellum-assistant",
  "owner": { "name": "Vellum", "url": "https://github.com/vellum-ai/vellum-assistant" },
  "plugins": [
    {
      "name": "example-plugin",
      "source": {
        "source": "github",
        "repo": "example-org/example-plugin",
        "ref": "e83c5163316f89bfbde7d9ab23ca2e25604af290"
      },
      "description": "Short summary shown in the catalog.",
      "category": "productivity",
      "homepage": "https://github.com/example-org/example-plugin",
      "license": "MIT"
    }
  ]
}`}</code>
          </pre>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            The fields each entry can set:
          </p>
          <ManifestTable fields={MANIFEST_FIELDS} />
        </section>

        <section id="commit-pinning" className="mt-12">
          <SectionHeading id="commit-pinning" level={2}>
            Why entries pin a commit
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            <code>source.ref</code> must be a full commit SHA. Tags and branches
            are rejected, because they are mutable: an upstream owner could
            retag or repoint them at different code, which the assistant would
            then clone and dynamically import. A full SHA pins the install to an
            immutable revision, so the reviewed manifest fully determines what
            executes.
          </p>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            To pin a release, resolve its tag to the underlying commit. Peel
            annotated tags with <code>{"^{}"}</code> so you record the commit,
            not the tag object:
          </p>
          <pre className="mb-0 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`# Resolve a release tag to its commit SHA
$ git ls-remote https://github.com/example-org/example-plugin 'refs/tags/v1.2.0^{}'
e83c5163316f89bfbde7d9ab23ca2e25604af290  refs/tags/v1.2.0^{}`}</code>
          </pre>
        </section>

        <section id="adapters" className="mt-12">
          <SectionHeading id="adapters" level={2}>
            Adapting external plugins
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Listing a plugin makes it install by name, but a plugin authored for
            another ecosystem may not match this loader&apos;s conventions and
            so contribute nothing on boot. A{" "}
            <strong>postinstall adapter</strong> bridges that gap: a small,
            curated transform committed alongside the marketplace entry that
            reshapes the cloned tree into Vellum&apos;s layout during install.
          </p>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            The adapter is a single JavaScript file referenced from the
            marketplace entry&apos;s <code>adapter</code> field. It runs after
            the plugin is cloned but before the loader scans for surfaces, so
            it can move files, generate a manifest, or rename entry points. The
            transform receives the cloned directory path and the marketplace
            entry, and is expected to leave the tree in Vellum&apos;s plugin
            layout:
          </p>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`// adapter.js — reshapes a Claude Code skill into Vellum layout
export default function adapt({ dir, entry }) {
  // The source repo ships instructions in SKILL.md at the root.
  // Vellum expects them under skills/<name>/SKILL.md.
  const fs = require("fs");
  const path = require("path");

  const skillDir = path.join(dir, "skills", entry.name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.renameSync(
    path.join(dir, "SKILL.md"),
    path.join(skillDir, "SKILL.md"),
  );

  // Generate a minimal package.json so the loader recognizes the plugin.
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: entry.name,
      version: entry.version,
      peerDependencies: { "@vellumai/plugin-api": ">=0.40.0" },
    }, null, 2),
  );
}`}
            </code>
          </pre>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            The adapter runs in the assistant&apos;s sandbox alongside the
            rest of the plugin install, with filesystem access limited to the
            plugin directory. Network access is not available during the
            adapt step.
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
