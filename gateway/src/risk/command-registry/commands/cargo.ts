import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  subcommands: {
    build: {
      baseRisk: "medium",
    },
    check: {
      baseRisk: "medium",
    },
    test: {
      baseRisk: "high",
      reason: "Executes arbitrary test code",
    },
    run: {
      baseRisk: "high",
      reason: "Compiles and executes code",
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
