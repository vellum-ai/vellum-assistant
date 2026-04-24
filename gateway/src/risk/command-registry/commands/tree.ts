import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "low",
  sandboxAutoApprove: true,
  filesystemOp: true,
  argSchema: {},
};

export default spec;
