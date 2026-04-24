import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  sandboxAutoApprove: true,
  filesystemOp: true,
  argSchema: {
    valueFlags: ["-t", "--target-directory"],
    pathFlags: {
      "-t": true,
      "--target-directory": true,
    },
  },
  argRules: [
    {
      id: "cp:system",
      valuePattern: "^/(?:usr|bin|sbin|lib|boot|dev|proc|sys)\\b",
      risk: "high",
      reason: "Copies to system path",
    },
  ],
};

export default spec;
