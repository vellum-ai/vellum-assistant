import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  reason: "Can write files or execute commands via sed scripts",
  sandboxAutoApprove: true,
  filesystemOp: true,
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
  argRules: [
    {
      id: "sed:inplace",
      flags: ["-i", "--in-place"],
      risk: "medium",
      reason: "Edits files in place",
    },
  ],
};

export default spec;
