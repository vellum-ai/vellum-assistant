import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  reason: "Locks shell variable/function state",
};

export default spec;
