import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  argSchema: {
    valueFlags: [
      "-d",
      "--data",
      "--data-binary",
      "--data-raw",
      "--data-urlencode",
      "-T",
      "--upload-file",
      "-o",
      "--output",
      "-H",
      "--header",
      "-X",
      "--request",
      "-u",
      "--user",
      "-A",
      "--user-agent",
      "-e",
      "--referer",
      "-b",
      "--cookie",
      "-c",
      "--cookie-jar",
      "--connect-timeout",
      "-m",
      "--max-time",
      "--retry",
      "-w",
      "--write-out",
    ],
    positionals: "none",
  },
  argRules: [
    {
      id: "curl:upload-data",
      flags: ["-d", "--data", "--data-binary", "--data-raw"],
      valuePattern: "^@",
      risk: "high",
      reason: "Uploads file contents",
    },
    {
      id: "curl:upload-file",
      flags: ["-T", "--upload-file"],
      risk: "high",
      reason: "Uploads file",
    },
    {
      id: "curl:output-sensitive",
      flags: ["-o", "--output"],
      valuePattern: "(?:^|/)(?:\\.ssh|\\.gnupg|\\.aws|\\.config|\\.env)\\b",
      risk: "high",
      reason: "Writes to sensitive path",
    },
    {
      id: "curl:localhost",
      valuePattern: "^https?://(localhost|127\\.0\\.0\\.1|\\[::1\\])",
      risk: "low",
      reason: "Local request",
    },
  ],
};

export default spec;
