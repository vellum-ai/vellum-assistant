/**
 * `assistant memory validate`: the read-only concept-page diagnostic.
 *
 * The report covers the concept-page substrate, which is the same store
 * under memory v2 and v3, so the command is tier-agnostic. It is also
 * registered as `assistant memory v2 validate` for as long as that namespace
 * exists; both spellings run {@link runMemoryValidate}.
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../../ipc/cli-client.js";
import type { MemoryV2ValidateResult } from "../../../plugins/defaults/memory/src/memory-v2-routes.js";
import { subcommand } from "../../lib/cli-command-help.js";
import { log } from "../../logger.js";

/** Print the validate report; sets a non-zero exit code on any violation. */
export async function runMemoryValidate(): Promise<void> {
  const result = await cliIpcCall<MemoryV2ValidateResult>(
    "memory_v2_validate",
    { body: {} },
  );

  if (!result.ok) {
    log.error(result.error ?? "Failed to validate memory state");
    process.exitCode = 1;
    return;
  }

  const report = result.result!;
  log.info(`Pages: ${report.pageCount}`);
  log.info(`Edges: ${report.edgeCount}`);
  log.info(
    `Dangling links: ${
      report.danglingLinks.length === 0 ? "none" : report.danglingLinks.length
    }`,
  );
  for (const d of report.danglingLinks) {
    log.info(`  - ${d.from} → ${d.to} (${d.kind})`);
  }
  log.info(
    `Oversized pages: ${
      report.oversizedPages.length === 0 ? "none" : report.oversizedPages.length
    }`,
  );
  for (const p of report.oversizedPages) {
    log.info(`  - ${p.slug}: ${p.chars} chars`);
  }
  log.info(
    `Parse failures: ${
      report.parseFailures.length === 0 ? "none" : report.parseFailures.length
    }`,
  );
  for (const p of report.parseFailures) {
    log.info(`  - ${p.slug}: ${p.error}`);
  }

  if (
    report.danglingLinks.length > 0 ||
    report.oversizedPages.length > 0 ||
    report.parseFailures.length > 0
  ) {
    process.exitCode = 1;
  }
}

export function registerMemoryValidateCommand(memory: Command): void {
  subcommand(memory, "validate").action(runMemoryValidate);
}
