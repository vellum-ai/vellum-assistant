# Tools — Agent Instructions

## No New Tools Policy

**New tool registrations require approval from Team Jarvis.**

The tool registration system (`class ... implements Tool` + `registerTool()`) is being phased out in favor of skill-based approaches. Before adding a new tool, contact Team Jarvis for approval.

## Why This Policy Exists

1. **Skills are preferred** — The project direction is to teach the assistant CLI tools via skills rather than hardcoding tool implementations. Skills are portable, self-contained, and don't require daemon changes.

2. **Context overhead** — Each registered tool adds to the system prompt and increases token usage for every conversation.

3. **Maintenance burden** — Tools require ongoing maintenance, testing, and security review. Skills can be iterated on independently.

## What To Do Instead

Instead of creating a new tool, consider:

1. **Create a bundled skill** in `assistant/src/config/bundled-skills/` — Skills teach the assistant to use existing CLI tools and are the preferred approach for new functionality.

2. **Use existing tools** — Many capabilities can be achieved by combining existing tools (bash, file operations, network tools) with skill instructions.

3. **External CLI tools** — If you need new functionality, consider whether it can be exposed as a CLI tool that the assistant can invoke via bash.

## If You Have Approval

If Team Jarvis has approved your new tool:

1. The pre-commit hook will block your commit by default
2. Use `git commit --no-verify` to bypass the hook
3. Include the approval context in your PR description

## Directory Structure

```
tools/
├── AGENTS.md              # This file
├── types.ts               # Tool interface definitions
├── registry.ts            # Tool registration machinery
├── tool-manifest.ts       # Declarative list of registered tools
├── shared/                # Shared utilities (not tools)
└── <category>/            # Tool implementations by category
    └── <tool>.ts          # Individual tool files
```

## Existing Tool Categories

- `apps/` — App proxy tools
- `assets/` — Asset management
- `browser/` — Headless browser tools
- `credentials/` — Credential management
- `filesystem/` — File read/write/edit
- `memory/` — Memory operations
- `network/` — Web fetch and search
- `skills/` — Skill management
- `system/` — System settings and permissions
- `terminal/` — Shell operations

## Questions?

Contact Team Jarvis before shipping a new tool.
