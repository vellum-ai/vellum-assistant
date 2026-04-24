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
    update: {
      baseRisk: "medium",
    },
    remove: {
      baseRisk: "medium",
    },
    "run-script": {
      baseRisk: "high",
      reason: "Executes arbitrary scripts",
    },
  },
};

export default spec;
