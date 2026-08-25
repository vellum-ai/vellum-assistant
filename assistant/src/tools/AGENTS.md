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

## Keep A Plugin Tool Off The Wire When It Is Irrelevant

A plugin tool can declare `isActive({ modelProfileKey })` on its `ToolDefinition`. The tool surface is rebuilt on every provider call, so the predicate decides per call whether the tool is advertised: return false and the model never sees its name, description, or schema, so the tool costs nothing on turns it cannot help with. Use it whenever a plugin tool is only useful under a condition the host can name (today: the profile the turn resolved to). It is the difference between a tool that charges every conversation and one that charges only the conversations that need it.

The predicate must be cheap and synchronous: it runs once per tool per provider call. Throwing counts as inactive; omitting the field means always active. It can only subtract from the surface: the host's own gates (subagent allowlist, disabled tools, disk pressure) run alongside it and still apply. Honored for plugin-owned tools only; core, skill, MCP, and workspace tools are gated by the host rules in `isToolActiveForContext` (`daemon/conversation-tool-setup.ts`).

## If You Have Approval

If the core team has approved your new tool:

1. The pre-commit hook will block your commit by default
2. Use `git commit --no-verify` to bypass the hook
3. Include the approval context in your PR description

## Questions?

Contact the core team before shipping a new tool.
