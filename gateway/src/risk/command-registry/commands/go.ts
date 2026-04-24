import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "low",
  subcommands: {
    mod: {
      baseRisk: "low",
    },
    vet: {
      baseRisk: "low",
    },
    version: {
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
      reason: "Compiles and executes Go code",
    },
    get: {
      baseRisk: "medium",
      reason:
        "Downloads and installs packages; may execute arbitrary code via tool directives",
    },
    generate: {
      baseRisk: "high",
      reason: "Runs arbitrary commands via //go:generate directives",
    },
  },
};

export default spec;
