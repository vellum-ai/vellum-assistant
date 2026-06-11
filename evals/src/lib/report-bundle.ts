/**
 * Static-site export of a single run's report card.
 *
 * `evals export --session <id> --out run.tar` packages everything the local
 * `evals server` would render for one session — the session overview, each
 * test/profile drill-in, and the raw subprocess/docker artifacts — into a
 * self-contained directory tree that is then tarred. The bundle is hostable
 * as plain static files (e.g. uploaded to the QA dashboard) with no report
 * server: every page is pre-rendered HTML with inline styles, and all the
 * report-server routes are rewritten to relative file paths.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { renderReportPage } from "./report-html";
import {
  findExecutionRunId,
  readProfileInSession,
  readReportRun,
  readReportSession,
  readTestInSession,
  type ReportSessionDetail,
  type SessionStatus,
} from "./report-data";

/** Filename the QA viewer (and a browser) opens first. */
export const BUNDLE_ENTRY = "index.html";

/** One file in the exported bundle, addressed by its POSIX path in the tar. */
export interface BundleFile {
  /** Path within the tar / extracted directory, e.g. `exec--t1--p1.html`. */
  path: string;
  /** UTF-8 file contents. */
  content: string;
}

/**
 * `metadata.json` at the root of every bundle. Self-describing enough that a
 * host (the QA dashboard) can list and label an uploaded run without parsing
 * any HTML — it mirrors the fields the report index shows per session.
 */
export interface BundleMetadata {
  schemaVersion: 1;
  kind: "evals-run-bundle";
  /** Entry HTML file to open when viewing the bundle. */
  entry: typeof BUNDLE_ENTRY;
  exportedAt: string;
  sessionId: string;
  sessionLabel?: string;
  status: SessionStatus;
  startedAt?: string;
  completedAt?: string;
  runCount: number;
  scoreTotal: number;
  profileIds: string[];
  testIds: string[];
  cliArgv?: string[];
}

/**
 * Rewrites the report server's absolute route hrefs to the relative file
 * names used inside a bundle. Pure string transform so it is unit-testable
 * without rendering a real run.
 *
 * Route → file mapping (all pages live at the bundle root):
 *   `/`                                              → index.html
 *   `/sessions/<sid>`                                → index.html
 *   `/sessions/<sid>/tests/<t>`                      → test--<t>.html
 *   `/sessions/<sid>/tests/<t>/profiles/<p>`         → exec--<t>--<p>.html
 *   `/sessions/<sid>/profiles/<p>`                   → profile--<p>.html
 *   `/api/runs/<runId>/files/<name>`                 → files/<runId>--<name>
 */
export function rewriteReportLinks(html: string): string {
  return html.replace(/href="([^"]*)"/g, (whole, href: string) => {
    const rewritten = rewriteRoute(href);
    return rewritten === undefined ? whole : `href="${rewritten}"`;
  });
}

function rewriteRoute(href: string): string | undefined {
  if (!href.startsWith("/")) return undefined;

  const file = href.match(/^\/api\/runs\/([^/]+)\/files\/(.+)$/);
  if (file) {
    return `files/${decodeURIComponent(file[1])}--${decodeURIComponent(file[2])}`;
  }

  const execution = href.match(
    /^\/sessions\/([^/]+)\/tests\/([^/]+)\/profiles\/([^/]+)$/,
  );
  if (execution) {
    return `exec--${decodeURIComponent(execution[2])}--${decodeURIComponent(execution[3])}.html`;
  }

  const test = href.match(/^\/sessions\/([^/]+)\/tests\/([^/]+)$/);
  if (test) {
    return `test--${decodeURIComponent(test[2])}.html`;
  }

  const profile = href.match(/^\/sessions\/([^/]+)\/profiles\/([^/]+)$/);
  if (profile) {
    return `profile--${decodeURIComponent(profile[2])}.html`;
  }

  if (/^\/sessions\/[^/]+$/.test(href) || href === "/") {
    return BUNDLE_ENTRY;
  }

  return undefined;
}

function bundleMetadata(session: ReportSessionDetail): BundleMetadata {
  return {
    schemaVersion: 1,
    kind: "evals-run-bundle",
    entry: BUNDLE_ENTRY,
    exportedAt: new Date().toISOString(),
    sessionId: session.sessionId,
    sessionLabel: session.sessionLabel,
    status: session.status,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    runCount: session.runCount,
    scoreTotal: session.scoreTotal,
    profileIds: session.profileIds,
    testIds: session.testIds,
    cliArgv: session.cliArgv,
  };
}

const renderStatic = (input: Parameters<typeof renderReportPage>[0]): string =>
  rewriteReportLinks(renderReportPage(input, { readOnly: true }));

/**
 * Builds the in-memory file tree for a session's bundle. Reads run artifacts
 * via the same report-data layer the local server uses, so the exported pages
 * are byte-for-byte the server's pages with links rewritten.
 */
export async function buildRunBundle(sessionId: string): Promise<BundleFile[]> {
  const session = await readReportSession(sessionId);
  if (!session) {
    throw new Error(`No session found for ${sessionId}`);
  }

  const files: BundleFile[] = [
    { path: BUNDLE_ENTRY, content: renderStatic({ kind: "session", session }) },
  ];

  for (const aggregate of session.profiles) {
    const profile = await readProfileInSession(sessionId, aggregate.profileId);
    if (!profile) continue;
    files.push({
      path: `profile--${aggregate.profileId}.html`,
      content: renderStatic({ kind: "profile", profile }),
    });
  }

  for (const testEntry of session.tests) {
    const test = await readTestInSession(sessionId, testEntry.testId);
    if (!test) continue;
    files.push({
      path: `test--${testEntry.testId}.html`,
      content: renderStatic({ kind: "test", test }),
    });

    for (const profile of test.profiles) {
      const runId = await findExecutionRunId(
        sessionId,
        testEntry.testId,
        profile.profileId,
      );
      if (!runId) continue;
      const run = await readReportRun(runId);
      files.push({
        path: `exec--${testEntry.testId}--${profile.profileId}.html`,
        content: renderStatic({ kind: "execution", run }),
      });

      // Inline-rendered logs also expose a "raw" download link; carry the
      // underlying files so those links resolve inside the bundle.
      for (const log of run.subprocessLogs) {
        files.push({
          path: `files/${runId}--${log.name}`,
          content: log.content,
        });
      }
      for (const artifact of run.dockerArtifacts) {
        files.push({
          path: `files/${runId}--${artifact.name}`,
          content: artifact.content,
        });
      }
    }
  }

  files.push({
    path: "metadata.json",
    content: `${JSON.stringify(bundleMetadata(session), null, 2)}\n`,
  });

  return files;
}

/** True when an `--out` path should be treated as a full bundle tar. */
export function isBundleOutput(outPath: string): boolean {
  return /\.tar$/i.test(outPath) || /\.t(ar\.gz|gz)$/i.test(outPath);
}

/**
 * Stages `files` into a temp directory and tars it to `outPath`. A `.tar.gz`
 * / `.tgz` extension produces a gzipped archive; `.tar` an uncompressed one.
 * Shells out to the system `tar` (universally available on dev/CI machines)
 * to avoid a tar-writer dependency in this minimal package.
 */
export async function writeBundleTar(
  outPath: string,
  files: BundleFile[],
): Promise<void> {
  const stageDir = await mkdtemp(join(tmpdir(), "evals-bundle-"));
  try {
    for (const file of files) {
      const dest = join(stageDir, file.path);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, file.content, "utf8");
    }

    const absOut = resolve(outPath);
    await mkdir(dirname(absOut), { recursive: true });
    const gzip = /\.t(ar\.gz|gz)$/i.test(outPath);
    const proc = Bun.spawn(
      ["tar", gzip ? "-czf" : "-cf", absOut, "-C", stageDir, "."],
      { stdout: "pipe", stderr: "pipe" },
    );
    const code = await proc.exited;
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`tar exited with code ${code}: ${stderr.trim()}`);
    }
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}
