/**
 * Category vocabulary for the integrations catalog, shared by the assistant
 * daemon (which stamps it on OAuth providers and marketplace MCP entries) and
 * the clients (which draw the category filter from it).
 *
 * The order here is the order clients show the categories in. The slug is the
 * wire value; the user-facing label is the client's, so it can be translated.
 */
export const INTEGRATION_CATEGORIES = [
  "productivity",
  "communication",
  "meetings",
  "sales",
  "marketing",
  "finance",
  "commerce",
  "engineering",
  "knowledge",
  "recruiting",
] as const;

export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number];

const INTEGRATION_CATEGORY_SET: ReadonlySet<string> = new Set(
  INTEGRATION_CATEGORIES,
);

/**
 * Whether `value` names a category this build knows. A client reading a newer
 * catalog treats an unknown slug as uncategorized rather than failing.
 */
export function isIntegrationCategory(
  value: unknown,
): value is IntegrationCategory {
  return typeof value === "string" && INTEGRATION_CATEGORY_SET.has(value);
}
