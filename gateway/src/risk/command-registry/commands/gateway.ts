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
        "set-risk-threshold": {
          baseRisk: "high",
          reason: "Writes a contact risk ceiling and can escalate auto-approval",
        },
      },
    },
  },
};

export default spec;
