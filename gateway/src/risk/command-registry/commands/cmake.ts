import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "high",
  reason: "Evaluates CMake scripts and can execute commands",
};

export default spec;
