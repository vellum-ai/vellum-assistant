import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "high",
  reason: "Executes arbitrary Ruby code",
};

export default spec;
