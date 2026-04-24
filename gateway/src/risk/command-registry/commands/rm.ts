import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "high",
  sandboxAutoApprove: true,
  filesystemOp: true,
  argSchema: {},
  argRules: [
    {
      id: "rm:recursive-force",
      flags: ["-rf", "-fr", "-Rf", "-fR"],
      risk: "high",
      reason: "Recursive force delete",
    },
    {
      id: "rm:recursive",
      flags: ["-r", "-R", "--recursive"],
      risk: "high",
      reason: "Recursive delete",
    },
    {
      id: "rm:tmp",
      valuePattern: "^(?:/tmp|/var/tmp|\\./|\\.\\.\\/)",
      risk: "medium",
      reason: "Removes temp files",
    },
    {
      id: "rm:system",
      valuePattern: "^/(?:usr|bin|sbin|lib|boot|dev|proc|sys)\\b",
      risk: "high",
      reason: "Removes system files",
    },
    {
      id: "rm:sensitive",
      valuePattern: "(?:^|/)(?:\\.ssh|\\.gnupg|\\.aws|\\.config|\\.env)\\b",
      risk: "high",
      reason: "Removes sensitive files",
    },
  ],
};

export default spec;
