"use client";

import Link from "next/link";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "overview", label: "Overview", level: 2 },
  { id: "supported-services", label: "Supported services", level: 2 },
  { id: "connecting", label: "Connecting an integration", level: 2 },
  { id: "security", label: "Security model", level: 2 },
  { id: "billing", label: "Billing", level: 2 },
  { id: "troubleshooting", label: "Troubleshooting", level: 2 },
];

export function OauthIntegrationsContent() {
  return (
    <>
      <DocsContent
        title="OAuth Integrations"
        breadcrumb="Docs / Key Concepts / OAuth Integrations"
        eyebrow="Key Concepts"
        subtitle="How Vellum connects to third-party services via OAuth2, what services are supported, and how your credentials stay secure."
      >
        {/* ------------------------------------------------------------------ */}
        {/* Overview                                                             */}
        {/* ------------------------------------------------------------------ */}
        <section id="overview">
          <SectionHeading id="overview" level={2}>
            Overview
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            Vellum connects to external services through OAuth2 integrations. Instead of
            copying API keys into chat, you authorize your assistant once through a
            standard browser-based OAuth flow. The resulting access token is stored
            securely in your local credential vault, and your assistant can call the
            service&apos;s APIs on your behalf whenever a task requires it.
          </p>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            Each integration is exposed as a bundled skill with its own set of tools. For
            example, connecting Gmail gives your assistant tools like{" "}
            <code className="text-sm">gmail_send</code>,{" "}
            <code className="text-sm">gmail_search</code>, and{" "}
            <code className="text-sm">gmail_archive</code>. Connecting Google Calendar adds
            event creation, listing, and update tools. You decide which
            integrations to connect, and you can revoke access at any time.
          </p>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Supported services                                                   */}
        {/* ------------------------------------------------------------------ */}
        <section id="supported-services" className="mt-12">
          <SectionHeading id="supported-services" level={2}>
            Supported services
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            The following integrations ship with every Vellum workspace and connect via
            OAuth2 unless noted otherwise.
          </p>
          <div className="overflow-x-auto">
            <table className="mb-4 w-full text-sm text-stone-600 dark:text-stone-400">
              <thead>
                <tr className="border-b border-stone-200 dark:border-moss-600">
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Service
                  </th>
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Auth type
                  </th>
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    What you can do
                  </th>
                  <th className="pb-3 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Notes
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50 dark:[&>tr:nth-child(even)]:bg-moss-900/30">
                  <tr>
                    <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                      Discord
                    </td>
                    <td className="py-3 pr-4">OAuth2</td>
                    <td className="py-3 pr-4">
                      Send messages, read channels, manage servers
                    </td>
                    <td className="py-3">
                      Server-level. The bot must be added to each server you want to access.
                    </td>
                  </tr>
                  <tr>
                    <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                      GitHub
                    </td>
                    <td className="py-3 pr-4">OAuth2</td>
                    <td className="py-3 pr-4">
                      Read repos, open issues, review PRs, manage labels, star repos
                    </td>
                    <td className="py-3">
                      Requires the repo and read:user scopes. Private repos accessible if granted.
                    </td>
                  </tr>
                  <tr>
                    <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                      Google
                    </td>
                    <td className="py-3 pr-4">OAuth2</td>
                    <td className="py-3 pr-4">
                      Gmail, Calendar, Drive, and Contacts
                    </td>
                    <td className="py-3">
                      Single OAuth connection covers all Google services. Can be revoked in Google Account settings.
                    </td>
                  </tr>
                  <tr>
                    <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                      HubSpot
                    </td>
                    <td className="py-3 pr-4">OAuth2</td>
                    <td className="py-3 pr-4">
                      CRM contacts and deals
                    </td>
                    <td className="py-3">
                      CRM-scoped. Access follows your HubSpot user permissions.
                    </td>
                  </tr>
                  <tr>
                    <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                      Linear
                    </td>
                    <td className="py-3 pr-4">OAuth2</td>
                    <td className="py-3 pr-4">
                      Issues and projects
                    </td>
                    <td className="py-3">
                      Organization-scoped. Access follows your Linear role permissions.
                    </td>
                  </tr>
                  <tr>
                    <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                      Twitter (X)
                    </td>
                    <td className="py-3 pr-4">OAuth2</td>
                    <td className="py-3 pr-4">
                      Posts and direct messages
                    </td>
                    <td className="py-3">
                      Paid. Per-call billing through Vellum credits at the platform rate.
                    </td>
                  </tr>
                  <tr>
                    <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                      Asana
                    </td>
                    <td className="py-3 pr-4">OAuth2</td>
                    <td className="py-3 pr-4">
                      Tasks and projects
                    </td>
                    <td className="py-3">
                      Workspace-scoped. Access follows your Asana workspace permissions.
                    </td>
                  </tr>
                  <tr>
                    <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                      Notion
                    </td>
                    <td className="py-3 pr-4">OAuth2</td>
                    <td className="py-3 pr-4">
                      Pages and databases
                    </td>
                    <td className="py-3">
                      Integration must be added to specific Notion pages to access them.
                    </td>
                  </tr>
                  <tr>
                    <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                      Outlook / Microsoft
                    </td>
                    <td className="py-3 pr-4">OAuth2</td>
                    <td className="py-3 pr-4">
                      Email and calendar
                    </td>
                    <td className="py-3">
                      Microsoft 365 OAuth. Covers Outlook email and calendar events.
                    </td>
                  </tr>
                  <tr>
                    <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                      Todoist
                    </td>
                    <td className="py-3 pr-4">OAuth2</td>
                    <td className="py-3 pr-4">
                      Tasks and projects
                    </td>
                    <td className="py-3">
                      Project-scoped. Access follows your Todoist project permissions.
                    </td>
                  </tr>
                </tbody>
            </table>
          </div>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            New integrations are added regularly. If a service you need isn&apos;t listed,
            you can often connect it via a custom skill using its API key, or request it
            through the{" "}
            <Link
              href="https://www.vellum.ai/roadmap"
              className="text-emerald-700 underline hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-300"
            >
              roadmap
            </Link>
            .
          </p>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Connecting                                                           */}
        {/* ------------------------------------------------------------------ */}
        <section id="connecting" className="mt-12">
          <SectionHeading id="connecting" level={2}>
            Connecting an integration
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            The fastest way to connect a service is to ask your assistant directly:
          </p>
          <div className="mb-4 overflow-x-auto rounded-lg bg-stone-100 px-4 py-3 dark:bg-moss-900/50">
            <code className="text-sm text-stone-800 dark:text-stone-200">
              &ldquo;Connect my Gmail&rdquo;
            </code>
          </div>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            Alternatively, you can connect through the Settings UI:
          </p>
          <ol className="mb-4 list-decimal space-y-2 pl-6 text-stone-600 dark:text-stone-400 marker:text-stone-400 dark:marker:text-stone-500">
            <li>
              Open <strong>Settings</strong> in your Vellum app.
            </li>
            <li>
              Navigate to the <strong>Integrations</strong> or <strong>Services</strong> tab.
            </li>
            <li>
              Find the service you want to connect and click <strong>Connect</strong>.
            </li>
            <li>
              Complete the OAuth flow in the browser window that opens.
            </li>
            <li>
              Return to Vellum. The integration status should show <strong>Connected</strong>.
            </li>
          </ol>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            You can disconnect an integration at any time through the same Settings panel,
            or by asking your assistant to disconnect it for you. Disconnecting deletes the
            stored token from your local vault immediately.
          </p>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Security model                                                       */}
        {/* ------------------------------------------------------------------ */}
        <section id="security" className="mt-12">
          <SectionHeading id="security" level={2}>
            Security model
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            OAuth tokens are handled with the same security model as API keys and passwords:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-stone-600 dark:text-stone-400 marker:text-stone-400 dark:marker:text-stone-500">
            <li>
              <strong>Local vault:</strong> Tokens are stored in your workspace&apos;s local
              credential vault, not on Vellum&apos;s servers. The platform never sees them.
            </li>
            <li>
              <strong>LLM isolation:</strong> The LLM never receives raw tokens. When a
              skill needs to call an API, the daemon retrieves the token and injects it
              into the HTTP request at the transport layer.
            </li>
            <li>
              <strong>Scoped permissions:</strong> Vellum requests the minimum OAuth scopes
              required for each service. You can review the exact scopes on the
              integration&apos;s detail page before connecting.
            </li>
            <li>
              <strong>Revocation:</strong> Disconnecting an integration in Vellum deletes
              the local token. You can also revoke access from the third-party service&apos;s
              own settings page (e.g., Google Account permissions) for an additional layer
              of control.
            </li>
          </ul>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            For more details on the credential vault and permissions model, see{" "}
            <Link
              href="/docs/trust-security/the-permissions-model"
              className="text-emerald-700 underline hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-300"
            >
              The Permissions Model
            </Link>
            .
          </p>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Billing                                                              */}
        {/* ------------------------------------------------------------------ */}
        <section id="billing" className="mt-12">
          <SectionHeading id="billing" level={2}>
            Billing
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            OAuth integrations fall into three billing categories:
          </p>
          <div className="overflow-x-auto">
            <table className="mb-4 w-full text-sm text-stone-600 dark:text-stone-400">
              <thead>
                <tr className="border-b border-stone-200 dark:border-moss-600">
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Category
                  </th>
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    What it covers
                  </th>
                  <th className="pb-3 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Who pays
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50 dark:[&>tr:nth-child(even)]:bg-moss-900/30">
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                    Managed OAuth (free)
                  </td>
                  <td className="py-3 pr-4">
                    Services where Vellum manages the OAuth app registration (Discord, GitHub, Google, HubSpot, Linear, Asana, Notion, Outlook, Todoist)
                  </td>
                  <td className="py-3">
                    No additional cost. These integrations are bundled with your Vellum workspace.
                  </td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                    Managed OAuth (billed)
                  </td>
                  <td className="py-3 pr-4">
                    Twitter (X) — Vellum manages the OAuth app, but the underlying API usage is billed per call.
                  </td>
                  <td className="py-3">
                    API calls are billed through Vellum credits at the platform rate.
                  </td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                    BYOK OAuth
                  </td>
                  <td className="py-3 pr-4">
                    Services where you register your own OAuth app (e.g., custom Twitter API tier, enterprise Google Workspace)
                  </td>
                  <td className="py-3">
                    You pay the third-party service directly under your own account and quota.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            Most integrations (GitHub, Notion, Linear, Google, Discord, Asana, Outlook,
            Todoist, and HubSpot) are managed OAuth with no additional cost. Only Twitter (X)
            managed OAuth incurs per-call billing through Vellum credits. BYOK is for
            advanced cases where you bring your own API keys or enterprise OAuth apps. For
            details on credit denominations and usage, see the{" "}
            <Link
              href="/docs/pricing"
              className="text-emerald-700 underline hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-300"
            >
              pricing page
            </Link>
            .
          </p>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Troubleshooting                                                      */}
        {/* ------------------------------------------------------------------ */}
        <section id="troubleshooting" className="mt-12">
          <SectionHeading id="troubleshooting" level={2}>
            Troubleshooting
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            Common issues and how to fix them:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-stone-600 dark:text-stone-400 marker:text-stone-400 dark:marker:text-stone-500">
            <li>
              <strong>OAuth connection failed:</strong> If you are on a corporate network,
              your IT team may block third-party OAuth. Ask them to whitelist the service&apos;s
              OAuth domain, or connect from a personal network.
            </li>
            <li>
              <strong>Token expired:</strong> OAuth tokens expire. Tell your assistant to
              reconnect the service (e.g., <em>&ldquo;Reconnect my Gmail&rdquo;</em>) and it
              will walk you through the authorization flow again.
            </li>
            <li>
              <strong>Insufficient permissions:</strong> If a skill says it can&apos;t
              perform an action (e.g., sending from a specific Gmail label), the OAuth scope
              may not cover it. Disconnect and reconnect, ensuring you grant all requested
              permissions during the flow.
            </li>
            <li>
              <strong>Rate limited:</strong> Some services enforce strict API rate limits
              (notably Twitter/X). If you hit limits, the assistant will tell you. You may
              need to upgrade your API tier with the service directly.
            </li>
          </ul>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            For more detailed troubleshooting steps, see the{" "}
            <Link
              href="/docs/help/common-issues"
              className="text-emerald-700 underline hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-300"
            >
              Common Issues
            </Link>{" "}
            page.
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
