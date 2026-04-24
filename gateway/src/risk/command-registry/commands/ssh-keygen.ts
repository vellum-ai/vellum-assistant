import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  filesystemOp: true,
  argSchema: {},
  reason: "Generates and can overwrite SSH keys",
};

export default spec;
