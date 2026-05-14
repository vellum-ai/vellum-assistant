#!/usr/bin/env bun

import { red } from "./cli/lib/cli-colors.js";
import {
  detectUnknownCommand,
  formatUnknownCommandMessage,
} from "./cli/lib/unknown-command.js";
import { buildCliProgram } from "./cli/program.js";

const program = await buildCliProgram();

// Commander processes `--help` before any action or hook fires, so
// `assistant <unknown> --help` would dump the root help instead of flagging
// the typo. Pre-scan argv so the unknown-command error wins over the help
// short-circuit. See cli/lib/unknown-command.ts.
const unknown = detectUnknownCommand(program, process.argv.slice(2));
if (unknown) {
  process.stderr.write(`${red(formatUnknownCommandMessage(unknown))}\n`);
  process.exit(1);
}

program.parse();
