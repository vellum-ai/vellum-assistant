import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { TestSetupCommand } from "../../../../src/lib/setup-command";

import { USAGE_WORKSPACE_FILENAME } from "./constants";

// Stage the committed usage export into the agent's workspace before the
// conversation starts, modelling the analytics export the user "already saved".
const usageCsv = readFileSync(
  join(import.meta.dir, "assets", USAGE_WORKSPACE_FILENAME),
  "utf8",
);

export default [
  {
    type: "stage-workspace-file",
    path: USAGE_WORKSPACE_FILENAME,
    content: usageCsv,
  },
] satisfies TestSetupCommand[];
