import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  subcommands: {
    status: {
      baseRisk: "low",
    },
    log: {
      baseRisk: "low",
    },
    diff: {
      baseRisk: "low",
    },
    pull: {
      baseRisk: "medium",
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
    remove: {
      baseRisk: "high",
    },
  },
};

export default spec;
