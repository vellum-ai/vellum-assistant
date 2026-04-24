import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "high",
  reason: "Executes Java bytecode",
  argRules: [
    {
      id: "java:version",
      flags: ["-version", "--version"],
      risk: "low",
      reason: "Prints version",
    },
  ],
};

export default spec;
