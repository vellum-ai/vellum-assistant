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
    why: {
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
    test: {
      baseRisk: "high",
      reason: "Executes arbitrary package scripts",
    },
    run: {
      baseRisk: "high",
      reason: "Executes arbitrary package scripts",
    },
    dlx: {
      baseRisk: "high",
      reason: "Downloads and executes package",
    },
  },
};

export default spec;
