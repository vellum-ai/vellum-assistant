import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "low",
  isWrapper: true,
  nonExecFlags: ["--help", "--version"],
};

export default spec;
