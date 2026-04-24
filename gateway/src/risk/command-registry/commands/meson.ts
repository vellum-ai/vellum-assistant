import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "high",
  reason: "Configures builds and can execute project-defined commands",
};

export default spec;
