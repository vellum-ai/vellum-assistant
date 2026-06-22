import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { TestSetupCommand } from "../../../../src/lib/setup-command";

import { PNL_WORKSPACE_FILENAME } from "./constants";

// Stage the committed P&L fixture into the agent's workspace before the
// conversation starts, modelling the spreadsheet the user "already uploaded".
const pnlCsv = readFileSync(
  join(import.meta.dir, "assets", PNL_WORKSPACE_FILENAME),
  "utf8",
);

export default [
  {
    type: "stage-workspace-file",
    path: PNL_WORKSPACE_FILENAME,
    content: pnlCsv,
  },
] satisfies TestSetupCommand[];
