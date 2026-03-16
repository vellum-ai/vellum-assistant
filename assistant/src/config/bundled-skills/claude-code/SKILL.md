---
name: claude-code
description: Delegate coding tasks to Claude Code, an AI-powered coding agent
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "💻"
  vellum:
    display-name: "Claude Code"
---

You are delegating a coding task to Claude Code, an autonomous AI coding agent. Use this skill when the user needs hands-on software engineering work done.

## Capabilities

Claude Code can:
- Read, write, and edit files across a codebase
- Run shell commands (build, test, lint, deploy scripts)
- Perform multi-step engineering tasks autonomously (refactoring, implementing features, debugging)
- Search codebases for patterns, definitions, and usage
- Work with git repositories (commits, branches, diffs)

## When to Delegate

Delegate to Claude Code when the task involves:
- Writing or modifying source code
- Running build/test/lint commands and iterating on failures
- Exploring a codebase to answer architectural questions
- Multi-file refactors or migrations
- Debugging issues that require reading code and running tests
- Any task that benefits from direct filesystem and shell access

Do NOT delegate when:
- The user just wants a conversational answer or explanation
- The task is pure information retrieval with no code changes needed
- The user explicitly wants to discuss an approach before implementation

## Guardrails

- Claude Code runs in a sandboxed environment with approval flows for destructive actions
- File writes, edits, and shell commands that modify state require user confirmation (unless auto-approved by trust rules)
- Read-only operations (file reads, searches, web fetches) are auto-approved
- The working directory defaults to the current conversation's working directory but can be overridden

## Worker Profiles

Claude Code supports scoped worker profiles that restrict tool access:

- **general** (default) — Full access to all tools.
- **researcher** — Read-only access. Can search, read files, and browse the web but cannot write or execute commands.
- **coder** — Full read/write/execute access optimized for implementation tasks.
- **reviewer** — Read-only access tailored for code review, with emphasis on analysis and feedback.

Select the profile that best matches the task to enforce least-privilege access.
