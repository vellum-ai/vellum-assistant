import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "high",
  reason: "Compilation can run annotation processors",
};

export default spec;
