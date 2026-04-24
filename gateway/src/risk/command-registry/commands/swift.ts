import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "low",
  subcommands: {
    package: {
      baseRisk: "low",
    },
    build: {
      baseRisk: "medium",
    },
    test: {
      baseRisk: "high",
      reason: "Executes arbitrary test code",
    },
    run: {
      baseRisk: "high",
      reason: "Compiles and executes Swift code",
    },
  },
};

export default spec;
