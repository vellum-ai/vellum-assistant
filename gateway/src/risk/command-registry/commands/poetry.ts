import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  subcommands: {
    show: {
      baseRisk: "low",
    },
    install: {
      baseRisk: "medium",
    },
    add: {
      baseRisk: "medium",
    },
    remove: {
      baseRisk: "medium",
    },
    run: {
      baseRisk: "high",
      reason: "Executes arbitrary commands",
    },
  },
};

export default spec;
