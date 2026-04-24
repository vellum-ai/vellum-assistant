import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  subcommands: {
    list: {
      baseRisk: "low",
    },
    show: {
      baseRisk: "low",
    },
    freeze: {
      baseRisk: "low",
    },
    install: {
      baseRisk: "medium",
    },
    uninstall: {
      baseRisk: "medium",
    },
  },
};

export default spec;
