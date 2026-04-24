import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  reason: "Opens arbitrary network connections",
};

export default spec;
