import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  subcommands: {
    list: {
      baseRisk: "low",
    },
    search: {
      baseRisk: "low",
    },
    status: {
      baseRisk: "low",
    },
    get: {
      baseRisk: "low",
    },
    template: {
      baseRisk: "low",
    },
    install: {
      baseRisk: "high",
      reason: "Installs workloads to cluster",
    },
    upgrade: {
      baseRisk: "high",
      reason: "Upgrades workloads in cluster",
    },
    rollback: {
      baseRisk: "high",
      reason: "Rolls back workloads in cluster",
    },
    uninstall: {
      baseRisk: "high",
      reason: "Removes workloads from cluster",
    },
  },
};

export default spec;
