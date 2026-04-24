import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "low",
  filesystemOp: true,
  argSchema: {
    valueFlags: [
      "-name",
      "-iname",
      "-path",
      "-ipath",
      "-regex",
      "-iregex",
      "-maxdepth",
      "-mindepth",
      "-newer",
      "-user",
      "-group",
      "-printf",
      "-fprintf",
    ],
  },
  complexSyntax: true,
  argRules: [
    {
      id: "find:exec",
      flags: ["-exec", "-execdir"],
      risk: "high",
      reason: "Executes arbitrary commands on matched files",
    },
    {
      id: "find:delete",
      flags: ["-delete"],
      risk: "high",
      reason: "Deletes matched files",
    },
  ],
};

export default spec;
