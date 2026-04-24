import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "high",
  reason: "Executes arbitrary Perl code",
  argRules: [
    {
      id: "perl:version",
      flags: ["--version", "-v"],
      risk: "low",
      reason: "Prints version",
    },
  ],
};

export default spec;
