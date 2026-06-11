import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  ensureRunArtifacts,
  runArtifacts,
  writeMetricResults,
  writeRunMetadata,
} from "../metrics";
import {
  buildRunBundle,
  isBundleOutput,
  rewriteReportLinks,
} from "../report-bundle";

async function seedRun(opts: {
  sessionId: string;
  sessionLabel?: string;
  profileId: string;
  profileManifest?: { species: "vellum"; description?: string };
  testId: string;
  score: number;
}): Promise<string> {
  const runId = `bundle-${opts.profileId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await ensureRunArtifacts(runId);
  const artifacts = runArtifacts(runId);
  await writeRunMetadata(runId, {
    runId,
    sessionId: opts.sessionId,
    sessionLabel: opts.sessionLabel,
    profileId: opts.profileId,
    profileManifest: opts.profileManifest,
    testId: opts.testId,
    status: "completed",
    startedAt: "2026-05-15T12:00:00.000Z",
    completedAt: "2026-05-15T12:00:02.000Z",
    artifactDir: artifacts.runDir,
  });
  await writeMetricResults(runId, [
    { name: "accuracy", score: opts.score, reason: "scored" },
  ]);
  return runId;
}

describe("rewriteReportLinks", () => {
  test("maps every report-server route to its relative bundle file", () => {
    // GIVEN HTML containing each absolute route the report pages emit
    const html = [
      `<a href="/">All runs</a>`,
      `<a href="/sessions/sess-1">Run</a>`,
      `<a href="/sessions/sess-1/tests/t1">Test</a>`,
      `<a href="/sessions/sess-1/tests/t1/profiles/p1">Exec</a>`,
      `<a href="/sessions/sess-1/profiles/p1">Profile</a>`,
      `<a href="/api/runs/run-9/files/subprocess-hatch.log">raw</a>`,
    ].join("\n");

    // WHEN we rewrite the links for a static bundle
    const out = rewriteReportLinks(html);

    // THEN each route points at the relative file that exists in the bundle
    expect(out).toContain(`href="index.html"`);
    expect(out).toContain(`href="test--t1.html"`);
    expect(out).toContain(`href="exec--t1--p1.html"`);
    expect(out).toContain(`href="profile--p1.html"`);
    expect(out).toContain(`href="files/run-9--subprocess-hatch.log"`);
    // AND no absolute server route survives
    expect(out).not.toContain(`href="/`);
  });

  test("leaves non-route hrefs untouched", () => {
    // GIVEN an external link and an in-page anchor
    const html = `<a href="https://example.com">x</a><a href="#top">y</a>`;

    // WHEN we rewrite links
    const out = rewriteReportLinks(html);

    // THEN they are preserved verbatim
    expect(out).toBe(html);
  });
});

describe("isBundleOutput", () => {
  test("treats tar-family extensions as bundles and everything else as JSONL", () => {
    // GIVEN/WHEN/THEN tar-family paths bundle; summary paths do not
    expect(isBundleOutput("run.tar")).toBe(true);
    expect(isBundleOutput("/tmp/run.TAR")).toBe(true);
    expect(isBundleOutput("run.tar.gz")).toBe(true);
    expect(isBundleOutput("run.tgz")).toBe(true);
    expect(isBundleOutput("card.jsonl")).toBe(false);
    expect(isBundleOutput("card.json")).toBe(false);
  });
});

describe("buildRunBundle", () => {
  test("packages a session into a self-contained, read-only static site", async () => {
    // GIVEN a session with one test run across two profiles
    const sessionId = `bundle-sess-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await seedRun({
      sessionId,
      sessionLabel: "smoke",
      profileId: "p1",
      profileManifest: {
        species: "vellum",
        description: "The bare baseline profile.",
      },
      testId: "t1",
      score: 1,
    });
    const p2RunId = await seedRun({
      sessionId,
      sessionLabel: "smoke",
      profileId: "p2",
      testId: "t1",
      score: 0,
    });
    // AND p2's run has a raw subprocess log on disk
    await writeFile(
      join(runArtifacts(p2RunId).runDir, "subprocess-hatch.log"),
      "hatch log body",
      "utf8",
    );

    // WHEN we build the bundle for that session
    const files = await buildRunBundle(sessionId);
    const byPath = new Map(files.map((file) => [file.path, file.content]));

    // THEN it has the entry page, a page per test and per execution, plus metadata
    expect(byPath.has("index.html")).toBe(true);
    expect(byPath.has("test--t1.html")).toBe(true);
    expect(byPath.has("exec--t1--p1.html")).toBe(true);
    expect(byPath.has("exec--t1--p2.html")).toBe(true);
    expect(byPath.has("metadata.json")).toBe(true);
    // AND a per-profile drill-down page per profile in the session
    expect(byPath.has("profile--p1.html")).toBe(true);
    expect(byPath.has("profile--p2.html")).toBe(true);
    // AND the profile page carries the manifest description in its info panel
    expect(byPath.get("profile--p1.html") ?? "").toContain(
      "The bare baseline profile.",
    );
    // AND the session page links its profile cards to those pages
    expect(byPath.get("index.html") ?? "").toContain(`href="profile--p1.html"`);
    // AND the raw subprocess log is carried so its "raw" link resolves
    expect(byPath.has(`files/${p2RunId}--subprocess-hatch.log`)).toBe(true);

    // AND internal links are rewritten to relative files (no server routes)
    const index = byPath.get("index.html") ?? "";
    expect(index).toContain(`href="test--t1.html"`);
    expect(index).not.toContain(`href="/sessions/`);

    // AND the execution page is read-only: no delete affordance, raw link is relative
    const exec = byPath.get("exec--t1--p2.html") ?? "";
    expect(exec).not.toContain("/delete");
    expect(exec).toContain(`href="files/${p2RunId}--subprocess-hatch.log"`);

    // AND metadata describes the run for a host to list it without parsing HTML
    const metadata = JSON.parse(byPath.get("metadata.json") ?? "{}");
    expect(metadata).toMatchObject({
      kind: "evals-run-bundle",
      entry: "index.html",
      sessionId,
      sessionLabel: "smoke",
      runCount: 2,
    });
    expect(metadata.testIds).toContain("t1");
    expect(metadata.profileIds).toEqual(expect.arrayContaining(["p1", "p2"]));
  });

  test("throws for an unknown session", async () => {
    // GIVEN a session id with no runs on disk
    // WHEN/THEN building a bundle rejects rather than emitting an empty tar
    await expect(buildRunBundle("does-not-exist")).rejects.toThrow(
      /No session found/,
    );
  });
});
