import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  subcommands: {
    list: {
      baseRisk: "low",
    },
    info: {
      baseRisk: "low",
    },
    search: {
      baseRisk: "low",
    },
    install: {
      baseRisk: "medium",
    },
    update: {
      baseRisk: "medium",
    },
    upgrade: {
      baseRisk: "medium",
    },
    uninstall: {
      baseRisk: "high",
    },
  },
};

export default spec;
