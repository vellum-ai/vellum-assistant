/**
 * Integration catalog for the /docs/integrations surface.
 *
 * Adding a new integration:
 *   1. Append an entry to INTEGRATIONS with a unique slug
 *   2. Create a content component at
 *        src/app/(marketing)/docs/_components/integrations-<slug>-content.tsx
 *   3. Create a route at
 *        src/app/(marketing)/docs/(integrations)/integrations/<slug>/page.tsx
 *   4. (Optional) Pick a lucide icon and wire it in integrations-nav.tsx
 */

export interface Integration {
  /** URL slug under /docs/integrations/<slug>. */
  slug: string;
  /** Display name shown in nav, cards, and headings. */
  name: string;
  /** One-line description for cards and meta tags. */
  blurb: string;
  /** Nav group label. */
  group: "Communication" | "Workspace & Web";
}

export const INTEGRATIONS: Integration[] = [
  {
    slug: "slack",
    name: "Slack",
    blurb: "Scan channels, summarize threads, post, and react with privacy-aware context sharing.",
    group: "Communication",
  },
  {
    slug: "gmail",
    name: "Gmail",
    blurb: "Read, draft, send, label, and triage email from any channel.",
    group: "Communication",
  },
  {
    slug: "discord",
    name: "Discord",
    blurb: "Post to channels, summarize threads, react, and bridge community signal.",
    group: "Communication",
  },
  {
    slug: "telegram",
    name: "Telegram",
    blurb: "Two-way chat with your assistant from anywhere, including wake-up alerts.",
    group: "Communication",
  },
  {
    slug: "twitter",
    name: "Twitter (X)",
    blurb: "Draft and post tweets, read mentions, monitor lists.",
    group: "Communication",
  },
  {
    slug: "google-calendar",
    name: "Google Calendar",
    blurb: "Schedule events, find conflicts, and brief your day.",
    group: "Workspace & Web",
  },
  {
    slug: "notion",
    name: "Notion",
    blurb: "Search, read, and update pages and databases.",
    group: "Workspace & Web",
  },
  {
    slug: "linear",
    name: "Linear",
    blurb: "Triage issues, create tickets, and close out cycles.",
    group: "Workspace & Web",
  },
  {
    slug: "hubspot",
    name: "HubSpot",
    blurb: "Pull contacts, log activity, and surface deal status.",
    group: "Workspace & Web",
  },
  {
    slug: "github",
    name: "GitHub",
    blurb: "Open PRs, search code, read issues, and ship from chat.",
    group: "Workspace & Web",
  },
  {
    slug: "tavily",
    name: "Tavily",
    blurb: "Real-time web search with citation-grade results.",
    group: "Workspace & Web",
  },
];

export const INTEGRATION_GROUPS = ["Communication", "Workspace & Web"] as const;

export type IntegrationGroup = (typeof INTEGRATION_GROUPS)[number];

export function getIntegrationBySlug(slug: string): Integration | undefined {
  return INTEGRATIONS.find((integration) => integration.slug === slug);
}

export function groupIntegrations(): Array<{ group: IntegrationGroup; items: Integration[] }> {
  return INTEGRATION_GROUPS.map((group) => ({
    group,
    items: INTEGRATIONS.filter((integration) => integration.group === group),
  }));
}
