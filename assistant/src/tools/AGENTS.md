# Tools - Agent Instructions

## New Non-Skill Tools Are Strongly Discouraged

**Prefer skills over new non-skill tool registrations.** Non-skill tools require approval from the core team.

Skills are the preferred approach for adding new capabilities — they are progressively disclosed into context, more portable, and can be iterated on independently. New non-skill tool registrations (`class ... implements Tool` + `registerTool()`) carry additional costs:

1. **Context overhead** — Each registered tool adds to the system prompt and increases token usage for every conversation.

2. **Maintenance burden** — Tools require ongoing maintenance, testing, and security review.

## What To Do Instead

Instead of creating a new tool, consider:

1. **Create a skill**

2. **Use existing tools** - Many capabilities can be achieved by combining existing tools (bash, file operations, network tools) with skill instructions.

3. **External CLI tools** - If you need new functionality, consider whether it can be exposed as a CLI tool that the assistant can invoke via bash.

## If You Have Approval

If the core team has approved your new tool:

1. The pre-commit hook will block your commit by default
2. Use `git commit --no-verify` to bypass the hook
3. Include the approval context in your PR description

## Questions?

Contact the core team before shipping a new tool.
