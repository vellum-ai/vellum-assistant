import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  isWrapper: true,
  reason: "Traces system calls",
};

export default spec;
