import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  argRules: [
    {
      id: "dmesg:clear",
      flags: ["-C", "--clear", "-c"],
      risk: "high",
      reason: "Clears kernel ring buffer",
    },
  ],
};

export default spec;
