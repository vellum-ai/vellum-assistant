import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  sandboxAutoApprove: true,
  filesystemOp: true,
  argSchema: {},
};

export default spec;
