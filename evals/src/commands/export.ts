/**
 * `evals export` — export a report session in one of three shapes, chosen by
 * the `--out` value:
 *
 *   • `--out card.jsonl` → a flat JSONL summary (scores/metrics) for eval
 *     comparison and diffing.
 *   • `--out run.tar`    → a self-contained static-site bundle of the full
 *     report (overview + per-execution transcripts/events + raw artifacts),
 *     hostable as plain files — e.g. uploaded to the QA dashboard for viewing.
 *   • `--out https://qa.vellum.ai` → build the bundle and push it to the QA
 *     dashboard's upload endpoint, so the run is immediately viewable online.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Command } from "commander";

import {
  buildBundleBuffer,
  buildRunBundle,
  isBundleOutput,
  isHttpUrlOut,
  writeBundleTar,
} from "../lib/report-bundle";
import {
  findExecutionRunId,
  readReportRun,
  readReportSession,
  readTestInSession,
} from "../lib/report-data";

type ExportRecord =
  | {
      // v2: the execution payload reports `assistantResponses` (folded
      // assistant replies) + `runtimeMs`, replacing v1's `transcriptTurns`
      // (raw per-delta transcript-entry count).
      type: "metadata";
      schemaVersion: 2;
      exportedAt: string;
      sessionId: string;
    }
  | { type: "session"; session: Awaited<ReturnType<typeof readReportSession>> }
  | {
      type: "test";
      test: NonNullable<Awaited<ReturnType<typeof readTestInSession>>>;
    }
  | {
      type: "execution";
      sessionId: string;
      testId: string;
      profileId: string;
      run: {
        runId: string;
        status: string;
        scoreTotal: number;
        metricCount: number;
        metrics: unknown[];
        assistantResponses: number;
        runtimeMs?: number;
        assistantEventCount: number;
        simulatorMessageCount: number;
        totalInputTokens?: number;
        totalOutputTokens?: number;
        totalCostUsd?: number;
      };
    };

function encodeJsonl(records: ExportRecord[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

export function registerExportCommand(program: Command): void {
  program
    .command("export")
    .description(
      "Export a report session: --out *.jsonl for a comparison summary, " +
        "--out *.tar (or *.tar.gz/*.tgz) for a self-contained, viewable bundle",
    )
    .requiredOption("--session <id>", "Session id to export")
    .requiredOption(
      "--out <path>",
      "Output path; *.tar/*.tar.gz/*.tgz bundles the full report, " +
        "an https:// URL pushes the bundle to a QA dashboard, " +
        "anything else writes a JSONL summary",
    )
    .action(async (opts: { session: string; out: string }) => {
      if (isHttpUrlOut(opts.out)) {
        await pushBundleToUrl(opts.session, opts.out);
        return;
      }

      if (isBundleOutput(opts.out)) {
        const files = await buildRunBundle(opts.session);
        await writeBundleTar(opts.out, files);
        console.log(
          `Bundled session ${opts.session} → ${opts.out} (${files.length} files)`,
        );
        return;
      }

      const session = await readReportSession(opts.session);
      if (!session) {
        throw new Error(`No session found for ${opts.session}`);
      }

      const records: ExportRecord[] = [
        {
          type: "metadata",
          schemaVersion: 2,
          exportedAt: new Date().toISOString(),
          sessionId: opts.session,
        },
        { type: "session", session },
      ];

      for (const testEntry of session.tests) {
        const test = await readTestInSession(opts.session, testEntry.testId);
        if (!test) continue;
        records.push({ type: "test", test });

        for (const profile of test.profiles) {
          const runId = await findExecutionRunId(
            opts.session,
            test.testId,
            profile.profileId,
          );
          if (!runId) continue;
          const run = await readReportRun(runId);
          records.push({
            type: "execution",
            sessionId: opts.session,
            testId: test.testId,
            profileId: profile.profileId,
            run: {
              runId: run.runId,
              status: run.status,
              scoreTotal: run.scoreTotal,
              metricCount: run.metricCount,
              metrics: run.metrics,
              assistantResponses: run.assistantResponses,
              runtimeMs: run.runtimeMs,
              assistantEventCount: run.assistantEventCount,
              simulatorMessageCount: run.simulatorMessageCount,
              totalInputTokens: run.totalInputTokens,
              totalOutputTokens: run.totalOutputTokens,
              totalCostUsd: run.totalCostUsd,
            },
          });
        }
      }

      await mkdir(dirname(opts.out), { recursive: true });
      await writeFile(opts.out, encodeJsonl(records), "utf8");
      console.log(`Exported ${records.length} records to ${opts.out}`);
    });
}

/**
 * Builds a session bundle and POSTs it to a QA dashboard's upload endpoint.
 * The `--out` URL (e.g. `https://qa.vellum.ai`) is resolved to
 * `<origin>/api/evals/upload`. Auth uses the `QA_AUTH_TOKEN` env var as a
 * Bearer token.
 */
async function pushBundleToUrl(
  sessionId: string,
  outUrl: string,
): Promise<void> {
  const authToken = process.env.QA_AUTH_TOKEN;
  if (!authToken) {
    throw new Error(
      "QA_AUTH_TOKEN is not set — export to a file instead, or set the " +
        "token env var to push directly to the QA dashboard.",
    );
  }

  const uploadUrl = outUrl.replace(/\/+$/, "") + "/api/evals/upload";

  console.log(`Bundling session ${sessionId}…`);
  const files = await buildRunBundle(sessionId);
  const buffer = await buildBundleBuffer(files);
  console.log(`Built bundle (${files.length} files, ${buffer.length} bytes)`);

  const formData = new FormData();
  formData.append(
    "file",
    new Blob([new Uint8Array(buffer)], { type: "application/gzip" }),
    "bundle.tar.gz",
  );

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${authToken}` },
    body: formData,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Upload failed (${response.status} ${response.statusText}): ${body}`,
    );
  }

  const result = (await response.json()) as { id?: string; sessionId?: string };
  const runId = result.id ?? result.sessionId ?? sessionId;
  console.log(`Pushed session ${sessionId} → ${outUrl} (run id: ${runId})`);
  console.log(`View at: ${outUrl.replace(/\/+$/, "")}/evals/runs/${runId}`);
}
