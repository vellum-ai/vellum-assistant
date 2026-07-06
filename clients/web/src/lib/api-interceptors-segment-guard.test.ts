/**
 * Guard: every assistant-scoped URL called through the PLATFORM HeyAPI client
 * must have a deliberately classified first segment.
 *
 * In local / self-hosted mode, `rewriteForSelfHostedIngress` only forwards a
 * platform-client request to the user's gateway when the path's first segment
 * is in `RUNTIME_PROXIED_FIRST_SEGMENTS` (api-interceptors.ts). A segment
 * missing from that list silently falls through to the platform and 404s —
 * a failure mode that has shipped user-facing breakage repeatedly: the
 * TimezoneSync `config` 502 flood, the `events` SSE stream, sandbox `/x/`
 * routes, and the contacts delete "Not Found" toast (LUM-2705).
 *
 * This test scans every hand-written module that imports the platform client
 * (`@/generated/api/client.gen`) for `/v1/assistants/{assistant_id}/...`
 * string literals and asserts each first segment is either:
 *   - in `RUNTIME_PROXIED_FIRST_SEGMENTS` (gateway/daemon serves it), or
 *   - in `PLATFORM_ROUTED_SEGMENTS` below (deliberately platform-bound,
 *     with a comment explaining why).
 *
 * A new segment fails this test until it is consciously classified. Raw
 * calls on the daemon/gateway clients are out of scope — those clients
 * forward all assistant-scoped paths unconditionally, so the allowlist
 * never applies to them. Prefer the generated SDKs over new raw calls
 * either way (see docs/CONVENTIONS.md "Prefer generated clients").
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_ROOT = join(import.meta.dir, "..");
const INTERCEPTORS_PATH = join(import.meta.dir, "api-interceptors.ts");

/**
 * Assistant-scoped segments that intentionally stay on the platform when
 * called through the platform client. Every entry needs a reason.
 */
const PLATFORM_ROUTED_SEGMENTS: Record<string, string> = {
  // Platform broker route (A2A invite redemption is brokered by Django);
  // there is no gateway/daemon counterpart.
  a2a: "platform A2A broker (contacts-gateway.ts redeemA2AInvite)",
  // No assistant-scoped artifacts route exists on the gateway or daemon;
  // forwarding would only turn the platform 404 into a gateway 404.
  artifacts: "no gateway/daemon route; platform-only until mirrored",
  // Platform-owned terminal session control plane.
  terminal: "platform-owned terminal sessions (terminal-stream.ts)",
  // Teleport uses the platform client ONLY for managed (cloud) assistants;
  // local assistants take the direct local-gateway fetch path with a
  // dedicated token mint (see teleport-gateway-client.ts module docs).
  migrations: "teleport managed-assistant transport (teleport-gateway-client.ts)",
};

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated" || entry.name === "node_modules") {
        continue;
      }
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) {continue;}
    if (/\.test\.tsx?$/.test(entry.name)) {continue;}
    out.push(full);
  }
  return out;
}

function readAllowlistedSegments(): Set<string> {
  const source = readFileSync(INTERCEPTORS_PATH, "utf-8");
  const block = source.match(
    /RUNTIME_PROXIED_FIRST_SEGMENTS = new Set<string>\(\[([\s\S]*?)\]\)/,
  );
  expect(block).not.toBeNull();
  const segments = new Set<string>();
  for (const m of block![1].matchAll(/"([^"]+)"/g)) {
    segments.add(m[1]);
  }
  expect(segments.size).toBeGreaterThan(0);
  return segments;
}

const PLATFORM_CLIENT_IMPORT = 'from "@/generated/api/client.gen"';
const ASSISTANT_SCOPED_URL_RE =
  /"\/v1\/assistants\/\{assistant_id\}\/([^/"?#]+)/g;

interface FoundSegment {
  file: string;
  segment: string;
}

function findPlatformClientSegments(): FoundSegment[] {
  const found: FoundSegment[] = [];
  for (const file of listSourceFiles(SRC_ROOT)) {
    const source = readFileSync(file, "utf-8");
    if (!source.includes(PLATFORM_CLIENT_IMPORT)) {continue;}
    for (const m of source.matchAll(ASSISTANT_SCOPED_URL_RE)) {
      found.push({ file: relative(SRC_ROOT, file), segment: m[1] });
    }
  }
  return found;
}

describe("platform-client assistant-scoped segment guard", () => {
  test("every assistant-scoped platform-client URL segment is classified", () => {
    const allowlisted = readAllowlistedSegments();
    const unclassified = findPlatformClientSegments().filter(
      ({ segment }) =>
        !allowlisted.has(segment) && !(segment in PLATFORM_ROUTED_SEGMENTS),
    );

    // A failure here means a platform-client call site targets an
    // assistant-scoped path whose first segment is neither forwarded to the
    // self-hosted gateway nor documented as platform-bound — in local /
    // self-hosted mode it will silently 404 at the platform (the LUM-2705
    // failure mode). Fix by either:
    //   1. using the generated daemon/gateway SDK for the call (preferred —
    //      those clients forward unconditionally), or
    //   2. adding the segment to RUNTIME_PROXIED_FIRST_SEGMENTS if the
    //      gateway/daemon serves the assistant-scoped route, or
    //   3. adding a commented PLATFORM_ROUTED_SEGMENTS entry above if the
    //      route is genuinely platform-owned.
    expect(unclassified).toEqual([]);
  });

  test("the guard actually sees the known call sites", () => {
    // If the scanner regressed (import string changed, URL shape changed),
    // it would vacuously pass. Pin at least one known platform-routed and
    // one known allowlisted segment so scanner breakage is loud.
    const segments = new Set(
      findPlatformClientSegments().map(({ segment }) => segment),
    );
    expect(segments.has("a2a")).toBe(true);
    expect(segments.has("trust-rules")).toBe(true);
  });

  test("platform-routed exceptions do not shadow the allowlist", () => {
    // An entry in both lists means the exception is stale — the segment now
    // forwards to the gateway and the PLATFORM_ROUTED_SEGMENTS entry must be
    // deleted so this guard keeps meaning one thing per segment.
    const allowlisted = readAllowlistedSegments();
    const overlap = Object.keys(PLATFORM_ROUTED_SEGMENTS).filter((s) =>
      allowlisted.has(s),
    );
    expect(overlap).toEqual([]);
  });
});
