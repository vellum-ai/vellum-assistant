import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  subcommands: {
    fmt: {
      baseRisk: "low",
    },
    validate: {
      baseRisk: "low",
    },
    plan: {
      baseRisk: "medium",
    },
    apply: {
      baseRisk: "high",
      reason: "Applies infrastructure changes",
    },
    destroy: {
      baseRisk: "high",
      reason: "Destroys managed infrastructure",
    },
    import: {
      baseRisk: "high",
      reason: "Mutates Terraform state",
    },
    state: {
      baseRisk: "medium",
      reason: "Reads or mutates Terraform state",
    },
  },
};

export default spec;
