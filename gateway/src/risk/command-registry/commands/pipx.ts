import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  subcommands: {
    list: {
      baseRisk: "low",
    },
    install: {
      baseRisk: "medium",
    },
    uninstall: {
      baseRisk: "medium",
    },
    run: {
      baseRisk: "high",
      reason: "Executes package entrypoint",
    },
  },
};

export default spec;
