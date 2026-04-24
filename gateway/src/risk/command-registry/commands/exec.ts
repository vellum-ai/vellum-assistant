import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "high",
  isWrapper: true,
  reason: "Replaces current shell process",
};

export default spec;
