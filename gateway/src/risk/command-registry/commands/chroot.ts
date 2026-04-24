import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "high",
  reason: "Changes root directory for command",
};

export default spec;
