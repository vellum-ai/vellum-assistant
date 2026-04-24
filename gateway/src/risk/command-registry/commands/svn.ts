import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  subcommands: {
    info: {
      baseRisk: "low",
    },
    status: {
      baseRisk: "low",
    },
    log: {
      baseRisk: "low",
    },
    diff: {
      baseRisk: "low",
    },
    update: {
      baseRisk: "medium",
    },
    add: {
      baseRisk: "medium",
    },
    commit: {
      baseRisk: "medium",
    },
    delete: {
      baseRisk: "high",
    },
  },
};

export default spec;
