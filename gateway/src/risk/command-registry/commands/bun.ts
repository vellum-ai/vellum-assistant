import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  subcommands: {
    install: {
      baseRisk: "medium",
    },
    add: {
      baseRisk: "medium",
    },
    update: {
      baseRisk: "medium",
    },
    test: {
      baseRisk: "high",
      reason: "Executes arbitrary test code",
    },
    run: {
      baseRisk: "high",
      reason: "Executes arbitrary scripts",
    },
  },
};

export default spec;
