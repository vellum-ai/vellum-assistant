import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "low",
  sandboxAutoApprove: true,
  filesystemOp: true,
  argSchema: {
    valueFlags: ["-o", "--output"],
    pathFlags: {
      "-o": true,
      "--output": true,
    },
  },
  argRules: [
    {
      id: "sort:output",
      flags: ["-o", "--output"],
      risk: "medium",
      reason: "Writes sorted output to file",
    },
    {
      id: "sort:output-sensitive",
      flags: ["-o", "--output"],
      valuePattern: "(?:^|/)(?:\\.ssh|\\.gnupg|\\.aws|\\.config|\\.env)\\b",
      risk: "high",
      reason: "Writes sorted output to sensitive path",
    },
  ],
};

export default spec;
