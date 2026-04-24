import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  sandboxAutoApprove: true,
  filesystemOp: true,
  argSchema: {},
  argRules: [
    {
      id: "mv:system",
      valuePattern: "^/(?:usr|bin|sbin|lib|boot|dev|proc|sys)\\b",
      risk: "high",
      reason: "Moves to system path",
    },
  ],
};

export default spec;
