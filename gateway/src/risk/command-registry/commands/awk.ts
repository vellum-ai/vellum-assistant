import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  argSchema: {
    positionals: [
      {
        role: "script",
      },
      {
        role: "path",
        rest: true,
      },
    ],
  },
  complexSyntax: true,
  reason: "Can execute shell commands via system()",
};

export default spec;
