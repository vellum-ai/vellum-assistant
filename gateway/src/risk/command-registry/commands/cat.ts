import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "low",
  sandboxAutoApprove: true,
  filesystemOp: true,
  argSchema: {},
  argRules: [
    {
      id: "cat:sensitive",
      valuePattern: "(?:^|/)(?:\\.ssh|\\.gnupg|\\.aws|\\.config|\\.env)\\b",
      risk: "high",
      reason: "Reads sensitive file",
    },
  ],
};

export default spec;
