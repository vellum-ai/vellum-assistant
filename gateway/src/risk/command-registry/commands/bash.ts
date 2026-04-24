import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "high",
  reason: "Executes arbitrary shell commands",
  complexSyntax: true,
};

export default spec;
