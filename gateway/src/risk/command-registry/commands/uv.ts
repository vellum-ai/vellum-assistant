import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  subcommands: {
    sync: {
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
    tool: {
      baseRisk: "medium",
      subcommands: {
        run: {
          baseRisk: "high",
          reason: "Executes installed tool",
        },
      },
    },
  },
};

export default spec;
