import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "low",
  isWrapper: true,
  nonExecFlags: ["-v", "-V"],
  argRules: [
    {
      id: "command:lookup",
      flags: ["-v", "-V"],
      risk: "low",
      reason: "Command lookup",
    },
  ],
};

export default spec;
