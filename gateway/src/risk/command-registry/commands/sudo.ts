import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "high",
  isWrapper: true,
  reason: "Elevates to superuser privileges",
};

export default spec;
