import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "high",
  reason: "Executes Gradle build scripts and plugins",
};

export default spec;
