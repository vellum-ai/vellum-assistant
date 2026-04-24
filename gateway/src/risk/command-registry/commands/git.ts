import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  argSchema: {
    valueFlags: [
      "-C",
      "-c",
      "--git-dir",
      "--work-tree",
      "--namespace",
      "--super-prefix",
      "--config-env",
    ],
  },
  subcommands: {
    status: {
      baseRisk: "low",
    },
    log: {
      baseRisk: "low",
    },
    diff: {
      baseRisk: "low",
    },
    show: {
      baseRisk: "low",
    },
    branch: {
      baseRisk: "low",
      argRules: [
        {
          id: "git-branch:delete",
          flags: ["-d", "-D", "--delete"],
          risk: "medium",
          reason: "Deletes local branch",
        },
        {
          id: "git-branch:move",
          flags: ["-m", "-M", "--move"],
          risk: "medium",
          reason: "Renames local branch",
        },
        {
          id: "git-branch:copy",
          flags: ["-c", "-C", "--copy"],
          risk: "medium",
          reason: "Copies local branch",
        },
      ],
    },
    tag: {
      baseRisk: "low",
      argRules: [
        {
          id: "git-tag:delete",
          flags: ["-d", "--delete"],
          risk: "high",
          reason: "Deletes git tag",
        },
      ],
    },
    remote: {
      baseRisk: "low",
      subcommands: {
        show: {
          baseRisk: "low",
        },
        "get-url": {
          baseRisk: "low",
        },
        add: {
          baseRisk: "medium",
          reason: "Adds git remote",
        },
        "set-url": {
          baseRisk: "medium",
          reason: "Changes remote URL",
        },
        rename: {
          baseRisk: "medium",
          reason: "Renames git remote",
        },
        remove: {
          baseRisk: "medium",
          reason: "Removes git remote",
        },
        prune: {
          baseRisk: "medium",
          reason: "Prunes stale remote refs",
        },
      },
    },
    stash: {
      baseRisk: "medium",
      subcommands: {
        list: {
          baseRisk: "low",
        },
        show: {
          baseRisk: "low",
        },
        drop: {
          baseRisk: "high",
          reason: "Permanently drops stashed changes",
        },
      },
    },
    blame: {
      baseRisk: "low",
    },
    shortlog: {
      baseRisk: "low",
    },
    describe: {
      baseRisk: "low",
    },
    "rev-parse": {
      baseRisk: "low",
    },
    "ls-files": {
      baseRisk: "low",
    },
    "ls-tree": {
      baseRisk: "low",
    },
    "cat-file": {
      baseRisk: "low",
    },
    reflog: {
      baseRisk: "low",
    },
    init: {
      baseRisk: "medium",
    },
    clone: {
      baseRisk: "medium",
    },
    add: {
      baseRisk: "medium",
    },
    commit: {
      baseRisk: "medium",
    },
    config: {
      baseRisk: "medium",
      argRules: [
        {
          id: "git-config:global",
          flags: ["--global"],
          risk: "high",
          reason: "Modifies global git configuration",
        },
        {
          id: "git-config:system",
          flags: ["--system"],
          risk: "high",
          reason: "Modifies system git configuration",
        },
      ],
    },
    checkout: {
      baseRisk: "medium",
    },
    restore: {
      baseRisk: "medium",
    },
    switch: {
      baseRisk: "medium",
    },
    merge: {
      baseRisk: "medium",
    },
    "cherry-pick": {
      baseRisk: "medium",
    },
    revert: {
      baseRisk: "medium",
    },
    rm: {
      baseRisk: "medium",
    },
    mv: {
      baseRisk: "medium",
    },
    rebase: {
      baseRisk: "medium",
      argRules: [
        {
          id: "git-rebase:interactive",
          flags: ["-i", "--interactive"],
          risk: "high",
          reason: "Interactive rebase rewrites history",
        },
      ],
    },
    push: {
      baseRisk: "medium",
      argRules: [
        {
          id: "git-push:force",
          flags: ["--force", "-f", "--force-with-lease"],
          risk: "high",
          reason: "Force push rewrites remote history",
        },
      ],
    },
    pull: {
      baseRisk: "medium",
    },
    fetch: {
      baseRisk: "low",
      argRules: [
        {
          id: "git-fetch:prune",
          flags: ["-p", "--prune"],
          risk: "medium",
          reason: "Prunes stale remote-tracking refs",
        },
      ],
    },
    reset: {
      baseRisk: "medium",
      argRules: [
        {
          id: "git-reset:hard",
          flags: ["--hard"],
          risk: "high",
          reason: "Discards uncommitted changes",
        },
      ],
    },
    clean: {
      baseRisk: "high",
      reason: "Removes untracked files",
    },
    bisect: {
      baseRisk: "low",
    },
    worktree: {
      baseRisk: "medium",
    },
    submodule: {
      baseRisk: "medium",
    },
  },
};

export default spec;
