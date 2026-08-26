import type { CommandRiskSpec } from "../../risk-types.js";

/**
 * Operator CLI for gateway-owned state (`gateway contacts ...`).
 */
const spec: CommandRiskSpec = {
  baseRisk: "low",
  subcommands: {
    contacts: {
      baseRisk: "low",
      subcommands: {
        list: {
          baseRisk: "low",
        },
        get: {
          baseRisk: "low",
        },
        "set-threshold": {
          baseRisk: "medium",
          reason: "Writes a contact assistant-access ceiling on the gateway",
        },
      },
    },
  },
};

export default spec;
