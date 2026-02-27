---
name: "skillssh-fallback"
description: "Search, evaluate, and install third-party skills from skills.sh with security audit visibility"
user-invocable: false
disable-model-invocation: false
metadata:
  vellum:
    requires:
      bins: ["bun"]
---

# Skills.sh Fallback

When a native capability fails or the user asks for something that could be handled by a third-party skill, use this workflow to search, evaluate, and install skills from skills.sh.

## When to trigger

- A tool or capability the user needs is not currently available
- A native command fails and a third-party skill could provide the functionality
- The user explicitly asks to find or install a skill for a specific task

## CLI commands

**IMPORTANT**: All commands MUST be run using the `host_bash` tool (not the sandbox `bash`). The CLI needs access to the host filesystem and bun runtime.

All commands use the `vellum skills` CLI, which is available on PATH:

```
host_bash: vellum skills <subcommand> [options]
```

### Search for skills

```
host_bash: vellum skills search "<query>" --limit 5 --json
```

Returns a list of matching skills with their risk levels and audit details.

### Evaluate a specific skill

```
host_bash: vellum skills evaluate <source> <skillId> --json
```

Fetches the security audit and produces a recommendation. The `source` is the GitHub repo path (e.g. `inference-sh-9/skills`) and `skillId` is the skill name (e.g. `youtube-thumbnail-design`).

### Install a skill

```
host_bash: vellum skills install <source> <skillId> --json
```

Runs the full install flow with security check. Pass `--override` to install despite a `do_not_recommend` security assessment.

## Workflow

Follow these steps in order. Do not skip the security evaluation or user confirmation.

### 1. Search

Run the search command with a relevant query describing what the user needs. Present the results to the user, highlighting the skill name, risk level, and install count.

### 2. Evaluate security

For the skill the user selects (or the best match), run the evaluate command. The security recommendation will be one of:

- **proceed** -- Safe/low risk. All audits passed. You may proceed with installation after confirming with the user.
- **proceed_with_caution** -- Medium risk detected. Present the rationale to the user and get explicit confirmation before installing.
- **do_not_recommend** -- High, critical, or unknown risk. Warn the user strongly. Explain the specific risks identified in the rationale. Only install if the user explicitly overrides after understanding the risks.

### 3. Present to user

Always tell the user:
- The skill name and what it does
- The security recommendation and rationale
- For `proceed_with_caution`: which audit dimensions flagged medium risk
- For `do_not_recommend`: the specific risk level and which providers flagged it

Ask for explicit confirmation before proceeding.

### 4. Install (if approved)

If the recommendation is `proceed` or `proceed_with_caution` and the user confirms:

```
host_bash: vellum skills install <source> <skillId> --json
```

If the recommendation is `do_not_recommend` and the user explicitly overrides:

```
host_bash: vellum skills install <source> <skillId> --override --json
```

### 5. Load the installed skill

After successful installation, load the skill so it becomes available in the current session:

```
skill_load skill=<skillId>
```

Then retry the original task using the newly loaded skill's capabilities.

## Loop guards

- Attempt the fallback flow at most **once per user request**. If the installed skill also fails, report the failure to the user rather than searching for another skill.
- Do not re-search for skills that were already evaluated and rejected (by the user or by security policy) in the same session.
