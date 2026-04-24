import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  argSchema: {
    valueFlags: ["-w", "--write", "-p", "--load"],
  },
  argRules: [
    {
      id: "sysctl:write",
      flags: ["-w", "--write"],
      risk: "high",
      reason: "Writes kernel parameters",
    },
    {
      id: "sysctl:load",
      flags: ["-p", "--load", "--system"],
      risk: "high",
      reason: "Loads kernel parameter settings",
    },
  ],
};

export default spec;
