import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "high",
  isWrapper: true,
  reason: "Elevates privileges (OpenBSD sudo alternative)",
};

export default spec;
