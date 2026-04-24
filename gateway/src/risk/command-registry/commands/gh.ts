import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "low",
  argSchema: {
    valueFlags: ["--repo", "-R"],
  },
  subcommands: {
    pr: {
      baseRisk: "low",
      subcommands: {
        view: {
          baseRisk: "low",
        },
        list: {
          baseRisk: "low",
        },
        create: {
          baseRisk: "medium",
        },
        merge: {
          baseRisk: "high",
          reason: "Merges pull request",
        },
      },
    },
    issue: {
      baseRisk: "low",
      subcommands: {
        view: {
          baseRisk: "low",
        },
        list: {
          baseRisk: "low",
        },
        create: {
          baseRisk: "medium",
        },
      },
    },
    repo: {
      baseRisk: "low",
      subcommands: {
        view: {
          baseRisk: "low",
        },
        clone: {
          baseRisk: "low",
        },
        create: {
          baseRisk: "high",
        },
        delete: {
          baseRisk: "high",
        },
      },
    },
    api: {
      baseRisk: "medium",
      reason: "Makes arbitrary GitHub API calls",
    },
  },
};

export default spec;
