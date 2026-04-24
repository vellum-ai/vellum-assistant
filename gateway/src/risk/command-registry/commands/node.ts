import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "high",
  reason: "Executes arbitrary JavaScript",
  argRules: [
    {
      id: "node:version",
      flags: ["--version", "-v"],
      risk: "low",
      reason: "Prints version",
    },
    {
      id: "node:eval",
      flags: ["-e", "--eval"],
      risk: "high",
      reason: "Evaluates inline JavaScript",
    },
  ],
};

export default spec;
