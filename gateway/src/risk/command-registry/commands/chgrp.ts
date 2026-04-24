import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "high",
  sandboxAutoApprove: true,
  argSchema: {},
  reason: "Changes file group",
};

export default spec;
