/**
 * `assistant db repair` — run the database repair sequence.
 *
 * Composes the step framework in `repair-steps.ts` with the concrete steps
 * imported from `repair-step-*.ts` files. Each step logs its own
 * starting/success/error lines; the runner aggregates results into a
 * `RepairReport` that renders either as plain text or as a single JSON
 * payload (`--json`).
 *
 * Adding a new step is a one-line edit to the `STEPS` array.
 *
 * Transport: `local`. The whole point of this surface is that it works when
 * the daemon is down, so it opens the DB file directly and never goes
 * through IPC.
 */

import { existsSync } from "node:fs";

import type { Command } from "commander";

import { getDbPath } from "../../../util/platform.js";
import { dim, green, red } from "../../lib/cli-colors.js";
import { shouldOutputJson, writeOutput } from "../../output.js";
import { conversationBackfillStep } from "./repair-step-conversation-backfill.js";
import { integrityCheckStep } from "./repair-step-integrity.js";
import type { RepairReport, RepairStep, StepResult } from "./repair-steps.js";
import { formatDurationMs, runRepairSteps } from "./repair-steps.js";

// ---------------------------------------------------------------------------
// Step sequence
// ---------------------------------------------------------------------------

/**
 * Repair steps run in the order listed here. Integrity check runs first so
 * structural damage surfaces before subsequent steps touch the same pages.
 */
const STEPS: RepairStep[] = [integrityCheckStep, conversationBackfillStep];

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderMissingDb(path: string): string {
  return (
    `${red("ERROR")}  Database not found at ${path}\n\n` +
    `Nothing to repair — the assistant SQLite database is missing. If you\n` +
    `have a backup, restore it first:\n` +
    `  assistant backup list\n`
  );
}

function emitStepStart(idx: number, total: number, step: RepairStep): void {
  process.stdout.write(
    `[${idx}/${total}] ${step.name} — ${dim("starting")}\n` +
      `        ${dim(step.description)}\n`,
  );
}

function emitStepFinish(
  idx: number,
  total: number,
  step: RepairStep,
  result: StepResult,
): void {
  const duration = formatDurationMs(result.durationMs ?? 0);
  if (result.status === "ok") {
    process.stdout.write(
      `[${idx}/${total}] ${step.name} — ${green("ok")}  ` +
        `${result.summary}  ${dim(`(${duration})`)}\n`,
    );
  } else {
    process.stdout.write(
      `[${idx}/${total}] ${step.name} — ${red("error")}  ` +
        `${result.summary}  ${dim(`(${duration})`)}\n`,
    );
  }
  for (const line of result.detailLines ?? []) {
    process.stdout.write(`        ${dim(line)}\n`);
  }
}

function renderSummary(report: RepairReport): string {
  const { okCount, errorCount, halted } = report;
  const total = report.steps.length;
  let line =
    `\nDone. ${total} step${total === 1 ? "" : "s"} ran: ` +
    `${okCount} ok, ${errorCount} failed`;
  if (halted) line += "  (sequence halted)";
  return line + "\n";
}

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

export function registerDbRepair(parent: Command): void {
  parent
    .command("repair")
    .description("Run the database repair sequence (integrity check, …)")
    .action(async function (this: Command) {
      const dbPath = getDbPath();

      if (!existsSync(dbPath)) {
        if (shouldOutputJson(this)) {
          writeOutput(this, {
            dbPath,
            missing: true,
            steps: [],
            okCount: 0,
            errorCount: 0,
            halted: false,
          });
        } else {
          process.stderr.write(renderMissingDb(dbPath));
        }
        process.exit(1);
      }

      const isJson = shouldOutputJson(this);

      const report = await runRepairSteps(
        { dbPath },
        STEPS,
        isJson
          ? {}
          : {
              onStart: emitStepStart,
              onFinish: emitStepFinish,
            },
      );

      if (isJson) {
        writeOutput(this, report);
      } else {
        process.stdout.write(renderSummary(report));
      }

      // Exit non-zero if any step failed — makes the command scriptable.
      if (report.errorCount > 0) process.exit(1);
    });
}
