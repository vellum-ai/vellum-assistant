import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "high",
  reason: "Executes arbitrary Lua code",
  argRules: [
    {
      id: "lua:version",
      flags: ["-v", "--version"],
      risk: "low",
      reason: "Prints version",
    },
  ],
};

export default spec;
