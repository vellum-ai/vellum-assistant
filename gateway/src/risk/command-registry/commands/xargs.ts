import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  complexSyntax: true,
  reason: "Executes command with piped arguments",
};

export default spec;
