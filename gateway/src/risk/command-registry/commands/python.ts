import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "high",
  reason: "Executes arbitrary Python code",
  argRules: [
    {
      id: "python:version",
      flags: ["--version", "-V"],
      risk: "low",
      reason: "Prints version",
    },
  ],
};

export default spec;
