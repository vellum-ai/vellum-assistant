import { cache } from "react";

export interface ApiRelease {
  version: string;
  released_at: string;
  is_stable: boolean;
  description: string | null;
  url: string | null;
}

/**
 * Resolves where release data is fetched from. Defaults to the public API;
 * RELEASES_API_URL overrides explicitly, and DJANGO_INTERNAL_URL supports
 * in-cluster fetch against the backend service directly.
 */
function getReleasesBaseUrl(): string {
  return (
    process.env.RELEASES_API_URL ||
    process.env.DJANGO_INTERNAL_URL ||
    "https://www.vellum.ai"
  );
}

// Shared by the releases sidebar and article list so link hrefs and element
// ids never diverge.
export function releaseAnchor(release: ApiRelease): string {
  return `v${release.version}`;
}

// Some releases are published with auto-generated build metadata only
// (e.g. "**Build:** `0.8.10` **Commit:** `abc123` **Built at:** ...").
// Metadata "Build:"/"Commit:" values are backtick-wrapped and "Built at:"
// lines are always machine-stamped, so those are stripped; human notes that
// merely start with the same word ("Build performance improved", "Commit:
// enforce signing everywhere") are kept.
export function hasRealNotes(release: ApiRelease): boolean {
  if (!release.description) {return false;}
  const stripped = release.description
    .split("\n")
    .filter(
      (line) =>
        !/^\s*[*_#>\-\s]*(\*\*)?\s*(built at\s*:|(build|commit)\s*:(\*\*)?\s*(`|$))/i.test(
          line,
        ),
    )
    .join("\n")
    .trim();
  return stripped.length > 0;
}

export const fetchReleases = cache(async (): Promise<ApiRelease[]> => {
  const baseUrl = getReleasesBaseUrl();
  const url = `${baseUrl}/v1/releases/?stable=true&limit=100`;
  try {
    const res = await fetch(url, {
      // When targeting an internal service URL, the request bypasses the load
      // balancer that terminates TLS and normally adds this header. Setting it
      // manually keeps the backend from redirecting insecure requests.
      headers: { "X-Forwarded-Proto": "https" },
      next: { revalidate: 60 },
      // Bound the request so a stalled upstream hits the empty-list fallback
      // instead of holding the dynamic releases render for the runtime's
      // default network timeout.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(
        `[releases] fetch failed: ${res.status} ${res.statusText}`,
        { url },
      );
      return [];
    }
    const releases: ApiRelease[] = await res.json();
    return releases.filter(hasRealNotes);
  } catch (err) {
    console.error("[releases] fetch error", { url, error: String(err) });
    return [];
  }
});

// Single source for the "Month Year" release label, shared by the month
// grouping below, the sidebar's current-month default, and the page title
// so the labels never diverge.
export function monthLabel(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function groupApiReleasesByMonth(releases: ApiRelease[]) {
  const groups: { month: string; releases: ApiRelease[] }[] = [];
  const monthMap = new Map<string, ApiRelease[]>();

  for (const release of releases) {
    const label = monthLabel(new Date(release.released_at));
    if (!monthMap.has(label)) {
      monthMap.set(label, []);
      groups.push({ month: label, releases: monthMap.get(label)! });
    }
    monthMap.get(label)!.push(release);
  }

  return groups;
}
