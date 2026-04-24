import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  argSchema: {
    valueFlags: ["--prefix", "--userconfig", "--globalconfig", "--cache"],
  },
  subcommands: {
    ls: {
      baseRisk: "low",
    },
    list: {
      baseRisk: "low",
    },
    outdated: {
      baseRisk: "low",
    },
    view: {
      baseRisk: "low",
    },
    info: {
      baseRisk: "low",
    },
    install: {
      baseRisk: "medium",
      reason: "Runs lifecycle scripts, downloads code",
    },
    ci: {
      baseRisk: "medium",
      reason: "Clean install, runs lifecycle scripts",
    },
    uninstall: {
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
    exec: {
      baseRisk: "high",
      reason: "Executes package binaries",
    },
    publish: {
      baseRisk: "high",
      reason: "Publishes package to registry",
    },
  },
};

export default spec;
