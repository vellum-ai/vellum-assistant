import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  subcommands: {
    get: {
      baseRisk: "low",
    },
    describe: {
      baseRisk: "low",
    },
    logs: {
      baseRisk: "low",
    },
    top: {
      baseRisk: "low",
    },
    version: {
      baseRisk: "low",
    },
    "cluster-info": {
      baseRisk: "low",
    },
    config: {
      baseRisk: "medium",
    },
    apply: {
      baseRisk: "high",
      reason: "Applies changes to cluster resources",
    },
    patch: {
      baseRisk: "high",
      reason: "Mutates cluster resources",
    },
    edit: {
      baseRisk: "high",
      reason: "Mutates cluster resources",
    },
    delete: {
      baseRisk: "high",
      reason: "Deletes cluster resources",
    },
    replace: {
      baseRisk: "high",
      reason: "Replaces cluster resources",
    },
    scale: {
      baseRisk: "high",
      reason: "Scales workloads in cluster",
    },
    exec: {
      baseRisk: "high",
      reason: "Executes commands in running cluster workloads",
    },
    cp: {
      baseRisk: "high",
      reason: "Copies files to/from workloads",
    },
    "port-forward": {
      baseRisk: "medium",
      reason: "Opens local network tunnel",
    },
  },
};

export default spec;
