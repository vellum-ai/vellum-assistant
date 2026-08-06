"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "what-it-does", label: "What it does", level: 2 },
  { id: "setup-required", label: "Setup required", level: 2 },
  { id: "permissions", label: "Permissions", level: 2 },
  { id: "common-prompts", label: "Common prompts", level: 2 },
  { id: "configuration", label: "Configuration", level: 2 },
  { id: "tips-gotchas", label: "Tips & gotchas", level: 2 },
];

export function SkillsReferenceBrowserContent() {
  return (
    <>
      <DocsContent title="Browser" breadcrumb="Docs / Skills Reference / Browser">
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Navigates web pages, interacts with elements, extracts content, fills forms, and
            takes screenshots using a headless browser. Your assistant&apos;s eyes and hands on
            the internet.
          </p>
        </section>

        <section id="setup-required" className="mt-12">
          <SectionHeading id="setup-required" level={2}>
            Setup required
          </SectionHeading>
          <p className="mb-0 text-zinc-600">None. Works immediately.</p>
        </section>

        <section id="permissions" className="mt-12">
          <SectionHeading id="permissions" level={2}>
            Permissions
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>No macOS permissions needed (runs in the sandbox)</li>
            <li>
              Credential fill requires stored credentials in the vault for auto-login scenarios
            </li>
          </ul>
        </section>

        <section id="common-prompts" className="mt-12">
          <SectionHeading id="common-prompts" level={2}>
            Common prompts
          </SectionHeading>
          <div className="mb-0 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-zinc-50">
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    You say...
                  </th>
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    What happens
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50">
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Go to example.com and tell me what&apos;s on the page&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Navigates, extracts, and summarizes page content
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Search for flights from JFK to Lisbon in June&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Navigates a travel site, extracts results
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;What does the homepage of [competitor] look like?&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Takes a screenshot of a webpage
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Fill out this form with my info&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Navigates to a form and fills fields
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Log into my Jira and check my open tickets&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Uses stored credentials to authenticate and extract data
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Read this article and summarize it&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Fetches and summarizes web content
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Click the &apos;Sign Up&apos; button on that page&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Interacts with specific page elements
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section id="configuration" className="mt-12">
          <SectionHeading id="configuration" level={2}>
            Configuration
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>No configuration needed for basic browsing</li>
            <li>
              For sites requiring login, store credentials in the vault: &ldquo;Store my GitHub login&rdquo;
            </li>
            <li>
              Credentials are scoped to specific domains (GitHub creds only work on github.com)
            </li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Not your browser.</strong> This is a headless browser that runs in the
              sandbox. It doesn&apos;t have your cookies, your logged-in sessions, or your bookmarks.
              It starts fresh every time.
            </li>
            <li>
              <strong>Login-required sites:</strong> You need to store credentials in the vault for
              your assistant to log into sites. It can&apos;t use your existing browser sessions.
            </li>
            <li>
              <strong>JavaScript-heavy sites:</strong> Most modern sites work fine. Occasionally,
              very complex single-page apps may not render perfectly in the headless browser.
            </li>
            <li>
              <strong>Screenshots:</strong> Your assistant can take visual screenshots if you want
              to see what a page actually looks like, rather than just the extracted text.
            </li>
            <li>
              <strong>Prefer APIs when available.</strong> If there&apos;s a direct API or CLI for a
              service (GitHub, Jira, etc.), your assistant will prefer that over browser automation.
              It&apos;s faster and more reliable.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
