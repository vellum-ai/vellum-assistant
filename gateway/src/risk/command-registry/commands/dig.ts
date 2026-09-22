import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  reason: "DNS lookup: the queried name reaches an external resolver",
};

export default spec;
