import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  sandboxAutoApprove: true,
  filesystemOp: true,
  argSchema: {
    valueFlags: [
      "-C",
      "--directory",
      "-f",
      "--file",
      "-I",
      "--use-compress-program",
      "--to-command",
      "--checkpoint-action",
    ],
    pathFlags: {
      "-C": true,
      "--directory": true,
      "-f": true,
      "--file": true,
    },
  },
  complexSyntax: true,
  argRules: [
    {
      id: "tar:to-command",
      flags: ["--to-command"],
      risk: "high",
      reason: "Executes arbitrary command during extraction",
    },
    {
      id: "tar:checkpoint-action",
      flags: ["--checkpoint-action"],
      risk: "high",
      reason: "Executes action at checkpoints",
    },
    {
      id: "tar:use-compress-program",
      flags: ["-I", "--use-compress-program"],
      risk: "high",
      reason: "Executes arbitrary compression program",
    },
  ],
};

export default spec;
