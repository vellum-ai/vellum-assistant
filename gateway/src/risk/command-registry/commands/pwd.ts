import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "low",
  sandboxAutoApprove: true,
  argSchema: {
    positionals: "none",
  },
};

export default spec;
