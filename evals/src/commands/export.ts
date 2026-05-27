/** `evals export` — JSONL export for report-card artifacts. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Command } from "commander";

import {
  findExecutionRunId,
  readReportRun,
  readReportSession,
  readTestInSession,
} from "../lib/report-data";

type ExportRecord =
  | { type: "metadata"; schemaVersion: 1; exportedAt: string; sessionId: string }
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
        transcriptTurns: number;
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
    .description("Export a report session as JSONL for eval comparison")
    .requiredOption("--session <id>", "Session id to export")
    .requiredOption("--out <path>", "Output JSONL path")
    .action(async (opts: { session: string; out: string }) => {
      const session = await readReportSession(opts.session);
      if (!session) {
        throw new Error(`No session found for ${opts.session}`);
      }

      const records: ExportRecord[] = [
        {
          type: "metadata",
          schemaVersion: 1,
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
              transcriptTurns: run.transcriptTurns,
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
