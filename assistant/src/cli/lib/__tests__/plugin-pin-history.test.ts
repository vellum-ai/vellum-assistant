/**
 * Tests for {@link listPinHistory} and {@link resolvePinToMarketplaceCommit}.
 *
 * The marketplace manifest stores only the current pin, so pin history is
 * reconstructed by walking the manifest's commit history and reading the
 * plugin's pin at each commit. The fixtures model that timeline with an
 * in-memory `fetch`: a commits-list endpoint plus a manifest-at-ref endpoint
 * keyed by commit SHA.
 */

import { describe, expect, test } from "bun:test";

import type { FetchLike } from "../fetch-like.js";
import {
  listPinHistory,
  resolvePinToMarketplaceCommit,
} from "../plugin-pin-history.js";

const PIN_A = "a".repeat(40);
const PIN_B = "b".repeat(40);
const PIN_C = "c".repeat(40);

// Marketplace-manifest commits, newest → oldest. `C2B` touches the manifest
// without changing this plugin's pin (a bump for some other plugin), so it must
// collapse into the same distinct pin as `C3`.
const C3 = "3".repeat(40);
const C2B = "d".repeat(40);
const C2 = "2".repeat(40);
const C1 = "1".repeat(40);

const COMMIT_DATES: Record<string, string> = {
  [C3]: "2026-06-10T00:00:00.000Z",
  [C2B]: "2026-06-08T00:00:00.000Z",
  [C2]: "2026-06-05T00:00:00.000Z",
  [C1]: "2026-06-01T00:00:00.000Z",
};

/** Plugin pin resolved from the manifest at each ref (`main` = current tip). */
const PIN_BY_REF: Record<string, string> = {
  main: PIN_C,
  [C3]: PIN_C,
  [C2B]: PIN_C,
  [C2]: PIN_B,
  [C1]: PIN_A,
};

function manifest(pin: string): string {
  return JSON.stringify({
    name: "vellum",
    plugins: [
      {
        name: "level-up",
        source: { source: "github", repo: "example-org/level-up", ref: pin },
      },
    ],
  });
}

/**
 * Build a `fetch` serving the commits list and the manifest at each ref.
 * `commits` is the newest-first commit list the API returns.
 */
function makeFetch(commits: string[] = [C3, C2B, C2, C1]): FetchLike {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/commits?")) {
      const body = commits.map((sha) => ({
        sha,
        commit: { committer: { date: COMMIT_DATES[sha] } },
      }));
      return new Response(JSON.stringify(body), { status: 200 });
    }
    const m = url.match(/contents\/plugins\/marketplace\.json\?ref=([^&]+)/);
    if (m) {
      const ref = decodeURIComponent(m[1]!);
      const pin = PIN_BY_REF[ref];
      if (!pin) return new Response("not found", { status: 404 });
      return new Response(manifest(pin), { status: 200 });
    }
    return new Response("unexpected url: " + url, { status: 500 });
  }) as FetchLike;
}

describe("listPinHistory", () => {
  test("lists distinct pins newest-first, collapsing unchanged revisions", async () => {
    // GIVEN a manifest history with three distinct pins (one commit left the
    // plugin's pin unchanged)
    const history = await listPinHistory("level-up", { fetch: makeFetch() });

    // THEN one entry per distinct pin, newest first, each tagged with the
    // newest marketplace commit that carries it
    expect(history).toEqual([
      {
        pin: PIN_C,
        marketplaceCommit: C3,
        promotedAt: COMMIT_DATES[C3]!,
        current: true,
      },
      {
        pin: PIN_B,
        marketplaceCommit: C2,
        promotedAt: COMMIT_DATES[C2]!,
        current: false,
      },
      {
        pin: PIN_A,
        marketplaceCommit: C1,
        promotedAt: COMMIT_DATES[C1]!,
        current: false,
      },
    ]);
  });

  test("honors the limit (newest pins win)", async () => {
    const history = await listPinHistory(
      "level-up",
      { fetch: makeFetch() },
      { limit: 2 },
    );
    expect(history.map((e) => e.pin)).toEqual([PIN_C, PIN_B]);
  });

  test("returns an empty list for a plugin absent from every revision", async () => {
    const history = await listPinHistory("ghost", { fetch: makeFetch() });
    expect(history).toEqual([]);
  });

  test("returns an empty list when the manifest has no commit history", async () => {
    const history = await listPinHistory("level-up", {
      fetch: makeFetch([]),
    });
    expect(history).toEqual([]);
  });
});

describe("resolvePinToMarketplaceCommit", () => {
  test("maps a reviewed pin to the marketplace commit that introduced it", async () => {
    const entry = await resolvePinToMarketplaceCommit("level-up", PIN_B, {
      fetch: makeFetch(),
    });
    expect(entry?.marketplaceCommit).toBe(C2);
    expect(entry?.pin).toBe(PIN_B);
  });

  test("is case-insensitive on the pin SHA", async () => {
    const entry = await resolvePinToMarketplaceCommit(
      "level-up",
      PIN_B.toUpperCase(),
      { fetch: makeFetch() },
    );
    expect(entry?.marketplaceCommit).toBe(C2);
  });

  test("returns null for a pin not in the reviewed history", async () => {
    const entry = await resolvePinToMarketplaceCommit(
      "level-up",
      "f".repeat(40),
      { fetch: makeFetch() },
    );
    expect(entry).toBeNull();
  });
});
