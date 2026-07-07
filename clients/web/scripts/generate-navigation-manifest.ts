/**
 * Generates src/navigation-manifest.json from the route registry
 * (src/utils/routes.ts) and the authored page descriptions
 * (src/utils/page-descriptions.ts).
 *
 * The manifest is consumed outside this repo (the platform doctor agent reads
 * it from release source tarballs) to point users at app pages, so it only
 * includes user-facing destinations.
 *
 * Run: bun run generate:nav-manifest
 */

import { writeFileSync } from "node:fs";
import path from "node:path";

import {
  INTERNAL_ROUTE_KEYS,
  PAGE_DESCRIPTIONS,
} from "../src/utils/page-descriptions";
import { routes } from "../src/utils/routes";
import { SETTINGS_SIDEBAR } from "../src/utils/settings-navigation";

export interface ManifestPage {
  key: string;
  path: string;
  label: string;
  section: string;
  description: string;
  dynamic?: boolean;
  features?: string[];
  tabs?: { id: string; query: string }[];
}

export interface NavigationManifest {
  version: 1;
  pages: ManifestPage[];
}

interface RouteEntry {
  key: string;
  path: string;
  dynamic: boolean;
}

/** `:param` placeholders for a route-builder function's declared params. */
function placeholderArgs(fn: (...args: string[]) => string): string[] {
  const match = fn.toString().match(/^\s*(?:function[^(]*)?\(([^)]*)\)/);
  const params = (match?.[1] ?? "")
    .split(",")
    .map((p) => p.replace(/[?=:].*$/, "").trim())
    .filter(Boolean);
  if (params.length > 0) {
    return params.map((p) => `:${p}`);
  }
  return Array.from({ length: fn.length }, (_, i) => `:arg${i}`);
}

/** Flattens the `routes` object into dot-keyed path entries. */
function collectRouteEntries(
  node: unknown = routes,
  prefix = "",
): RouteEntry[] {
  if (typeof node === "string") {
    return [{ key: prefix, path: node, dynamic: false }];
  }
  if (typeof node === "function") {
    const fn = node as (...args: string[]) => string;
    return [{ key: prefix, path: fn(...placeholderArgs(fn)), dynamic: true }];
  }
  if (node !== null && typeof node === "object") {
    return Object.entries(node).flatMap(([name, child]) =>
      collectRouteEntries(child, prefix ? `${prefix}.${name}` : name),
    );
  }
  return [];
}

function titleCase(key: string): string {
  const leaf = key.split(".").at(-1) ?? key;
  return leaf
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

function sectionFor(key: string): string {
  if (key.startsWith("settings.")) {return "Settings";}
  if (key.startsWith("logs.")) {return "Logs";}
  return "App";
}

/** Route keys neither described nor marked internal in page-descriptions.ts. */
export function missingRouteKeys(): string[] {
  return collectRouteEntries()
    .map((e) => e.key)
    .filter((k) => !(k in PAGE_DESCRIPTIONS) && !INTERNAL_ROUTE_KEYS.has(k));
}

/** Described/internal keys that no longer exist in routes.ts. */
export function staleDescriptionKeys(): string[] {
  const known = new Set(collectRouteEntries().map((e) => e.key));
  return [...Object.keys(PAGE_DESCRIPTIONS), ...INTERNAL_ROUTE_KEYS].filter(
    (k) => !known.has(k),
  );
}

export function buildManifest(): NavigationManifest {
  const entries = collectRouteEntries();
  const labelByPath = new Map(SETTINGS_SIDEBAR.map((i) => [i.href, i.label]));

  const missing = missingRouteKeys();
  if (missing.length > 0) {
    throw new Error(
      `Route keys missing from PAGE_DESCRIPTIONS and INTERNAL_ROUTE_KEYS: ${missing.join(", ")}. ` +
        "Describe them (or mark them internal) in src/utils/page-descriptions.ts.",
    );
  }

  const stale = staleDescriptionKeys();
  if (stale.length > 0) {
    throw new Error(
      `page-descriptions.ts references route keys that no longer exist in routes.ts: ${stale.join(", ")}.`,
    );
  }

  const pages = entries
    .filter((e) => !INTERNAL_ROUTE_KEYS.has(e.key))
    .map((e): ManifestPage => {
      const d = PAGE_DESCRIPTIONS[e.key];
      return {
        key: e.key,
        path: e.path,
        label: labelByPath.get(e.path) ?? d.label ?? titleCase(e.key),
        section: d.section ?? sectionFor(e.key),
        description: d.description,
        ...(e.dynamic ? { dynamic: true } : {}),
        ...(d.features ? { features: d.features } : {}),
        ...(d.tabs ? { tabs: d.tabs } : {}),
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));

  return { version: 1, pages };
}

if (import.meta.main) {
  const manifest = buildManifest();
  const outPath = path.join(import.meta.dir, "../src/navigation-manifest.json");
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${manifest.pages.length} pages to ${outPath}`);
}
