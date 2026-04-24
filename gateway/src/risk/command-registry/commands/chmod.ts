import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "high",
  sandboxAutoApprove: true,
  filesystemOp: true,
  argSchema: {},
  reason: "Changes file permissions",
};

export default spec;
