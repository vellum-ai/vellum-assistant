import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  sandboxAutoApprove: true,
  filesystemOp: true,
  argSchema: {
    valueFlags: ["-t", "--target-directory"],
    pathFlags: {
      "-t": true,
      "--target-directory": true,
    },
  },
};

export default spec;
