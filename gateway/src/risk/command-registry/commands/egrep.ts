import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "low",
  filesystemOp: true,
  argSchema: {
    positionals: [
      {
        role: "pattern",
      },
      {
        role: "path",
        rest: true,
      },
    ],
  },
};

export default spec;
