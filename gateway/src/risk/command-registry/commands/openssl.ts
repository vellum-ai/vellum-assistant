import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  reason: "Performs cryptographic operations",
};

export default spec;
