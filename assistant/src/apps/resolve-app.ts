/**
 * Resolve a user-facing app query (display name, slug, or id) to an
 * enumerated app. Used by `assistant apps inspect` / `refresh`.
 */

import { basename } from "node:path";

import { type EnumeratedApp, listAllApps } from "./app-store.js";

export type ResolveAppQueryResult =
  | { readonly ok: true; readonly app: EnumeratedApp }
  | { readonly ok: false; readonly reason: "not_found"; readonly query: string }
  | {
      readonly ok: false;
      readonly reason: "ambiguous";
      readonly query: string;
      readonly matches: readonly EnumeratedApp[];
    };

function matchesQuery(app: EnumeratedApp, query: string): boolean {
  if (app.id === query) {
    return true;
  }
  const lowered = query.toLowerCase();
  if (app.name.toLowerCase() === lowered) {
    return true;
  }
  const dirName = basename(app.sourcePath);
  return dirName.toLowerCase() === lowered;
}

/**
 * Resolve `query` against every surfaced app. Matching is exact on id, and
 * case-insensitive on display name and directory slug. Multiple distinct apps
 * that match yield `ambiguous` rather than picking a winner.
 */
export function resolveAppQuery(query: string): ResolveAppQueryResult {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "not_found", query };
  }

  const matches: EnumeratedApp[] = [];
  const seen = new Set<string>();
  for (const app of listAllApps()) {
    if (!matchesQuery(app, trimmed) || seen.has(app.id)) {
      continue;
    }
    seen.add(app.id);
    matches.push(app);
  }

  if (matches.length === 1) {
    return { ok: true, app: matches[0] };
  }
  if (matches.length > 1) {
    return { ok: false, reason: "ambiguous", query: trimmed, matches };
  }
  return { ok: false, reason: "not_found", query: trimmed };
}

export function formatAppMatch(app: EnumeratedApp): string {
  const origin =
    app.origin.kind === "plugin"
      ? `plugin ${app.origin.pluginName}`
      : "workspace";
  return `${app.name} (${origin}, ${app.id})`;
}

export function appNotFoundMessage(query: string): string {
  return `App "${query}" not found. Run 'assistant apps list' to see available apps.`;
}

export function appAmbiguousMessage(
  query: string,
  matches: readonly EnumeratedApp[],
): string {
  const listed = matches.map((app) => `  ${formatAppMatch(app)}`).join("\n");
  return `Ambiguous app name "${query}". Matches:\n${listed}\nRun 'assistant apps list' and pass a unique name, slug, or id.`;
}

