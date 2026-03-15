# Tools — Agent Instructions

## No New Tools Policy

**New tool registrations require approval from Team Jarvis.**

The tool registration system (`class ... implements Tool` + `registerTool()`) is being phased out in favor of skill-based approaches. Before adding a new tool, contact Team Jarvis for approval.

## Why This Policy Exists

1. **Skills are preferred** — The project direction is to teach the assistant CLI tools via skills rather than hardcoding tool implementations. Skills are progressively disclosed into context, are more portable, and are often self-contained.

2. **Context overhead** — Each registered tool adds to the system prompt and increases token usage for every conversation.

3. **Maintenance burden** — Tools require ongoing maintenance, testing, and security review. Skills can be iterated on independently.

## What To Do Instead

Instead of creating a new tool, consider:

1. **Create a skill**

2. **Use existing tools** — Many capabilities can be achieved by combining existing tools (bash, file operations, network tools) with skill instructions.

3. **External CLI tools** — If you need new functionality, consider whether it can be exposed as a CLI tool that the assistant can invoke via bash.

## Approved Exception: Credential Execution Service (CES) Tools

The following three CES tools are the only approved exception to the no-new-tools policy:

| Tool                         | Purpose                                                                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_authenticated_command`  | Execute a shell command with credential env vars injected by CES across a hard process boundary                                                            |
| `make_authenticated_request` | Execute an authenticated HTTP request with credentials injected by CES; returns response body and status only                                              |
| `manage_secure_command_tool` | Register and manage secure command tool bundles in the CES toolstore; handles bundle lifecycle (registration, unregistration) for manifest-driven commands |

These tools exist as `class ... implements Tool` registrations because:

- They enforce hard process-boundary isolation — credential values are materialized only inside the CES process (`credential-executor/` package), never in the assistant process
- Skills run inside the assistant process and cannot provide this isolation guarantee
- The tools are thin RPC stubs; actual credential materialization and execution logic lives in the separate `credential-executor/` package

**Key constraints**:

- CES is a **separate package and image** — no direct source imports from `assistant/` to `credential-executor/` or vice versa
- **Grants and audit logs are CES-owned** durable state — the assistant never reads or writes CES grant or audit tables directly
- `host_bash` is **outside the strong CES secrecy guarantee** — it does not enforce credential isolation
- Secure generic authenticated HTTP **must not** run through `run_authenticated_command` — use `make_authenticated_request` instead, which enforces domain validation and produces structured audit logs
- Managed rollout requires a **third runtime image** (alongside assistant and gateway) and `vembda` pod-template changes

See [`assistant/docs/credential-execution-service.md`](../../docs/credential-execution-service.md) for the full ADR.

## If You Have Approval

If Team Jarvis has approved your new tool:

1. The pre-commit hook will block your commit by default
2. Use `git commit --no-verify` to bypass the hook
3. Include the approval context in your PR description

## Questions?

Contact Team Jarvis before shipping a new tool.
