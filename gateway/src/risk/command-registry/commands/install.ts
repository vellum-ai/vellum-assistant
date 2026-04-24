import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
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
      id: "install:system",
      valuePattern: "^/(?:usr|bin|sbin|lib|boot|dev|proc|sys)\\b",
      risk: "high",
      reason: "Installs files into system path",
    },
  ],
};

export default spec;
