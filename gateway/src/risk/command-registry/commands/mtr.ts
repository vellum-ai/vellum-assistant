import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  reason: "Network probe: resolves and contacts an arbitrary host",
};

export default spec;
