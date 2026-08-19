/**
 * `assistant memory validate`: the read-only concept-page diagnostic.
 *
 * The report covers the concept-page substrate, which is the same store
 * under memory v2 and v3, so the command is tier-agnostic. The report
 * function lives in `memory-v2.ts` (the host file already allowed to read
 * the memory plugin's route types) and is also registered there as
 * `assistant memory v2 validate` for as long as that namespace exists.
 */

import type { Command } from "commander";

import { subcommand } from "../../lib/cli-command-help.js";
import { runMemoryValidate } from "./memory-v2.js";

export function registerMemoryValidateCommand(memory: Command): void {
  subcommand(memory, "validate").action(runMemoryValidate);
}
