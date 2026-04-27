# Skills — Security Model

This document describes the security model for the Vellum Assistant skill system, including how skills are authorized, how trust rules interact with skill versions, and how the system protects against privilege escalation through skill source mutations.

## Overview

Skills extend the assistant's capabilities by providing instructions (via `SKILL.md`) and optional custom tools (via `TOOLS.json`). Skills can be **bundled** (shipped with the application), **managed** (user-installed via `scaffold_managed_skill`), **workspace** (project-local), or **extra** (additional directories configured by the user).

Because skills can introduce arbitrary tool behavior, they are subject to stricter permission defaults than core tools.

## Permission Defaults for Skill Tools

Skill-origin tools follow a stricter default permission policy than core tools:

| Scenario                                          | Core tool behavior            | Skill tool behavior |
| ------------------------------------------------- | ----------------------------- | ------------------- |
| Low risk, no matching rule                        | Auto-allowed (at default threshold) | **Prompted**        |
| Medium risk, no matching rule                     | Prompted                      | Prompted            |
| High risk, no matching rule                       | Prompted                      | Prompted            |
| Allow rule matches, non-high risk                 | Auto-allowed                  | Auto-allowed        |
| Allow rule matches, high risk, containerized bash | Auto-allowed (runtime check)  | Auto-allowed        |
| Allow rule matches, high risk, other              | Prompted                      | Prompted            |

Even if a skill's `TOOLS.json` declares `"risk": "low"` for one of its tools, the permission checker will prompt the user unless an explicit trust rule in `~/.vellum/protected/trust.json` allows it. This prevents third-party skill tools from silently auto-executing.

## Skill Load Approval

The `skill_load` tool activates a skill within the current session. When `autoApproveUpTo` is set to `"none"`, loading a skill requires an explicit matching trust rule. At the default threshold (`"low"`), `skill_load` is prompted unless a matching trust rule exists.

When `skill_load` is invoked, the permission checker generates multiple command candidates for rule matching:

1. **Version-specific**: `skill_load:<skill-id>@<version-hash>` — matches rules that pin approval to an exact version of the skill's source code.
2. **Any-version**: `skill_load:<skill-id>` — matches rules that allow loading the skill regardless of its current version.
3. **Raw selector**: `skill_load:<raw-input>` — matches the literal user-provided selector as a fallback.

The allowlist options presented during a permission prompt include both version-specific and any-version patterns, letting the user choose their desired granularity.

## Version-Bound Approvals

Trust rules for `skill_load` can use version-specific patterns (e.g., `skill_load:my-skill@v1:abc123...`) to pin approval to a specific content hash of the skill's source files.

### How version hashing works

The `computeSkillVersionHash(directoryPath)` function computes a deterministic SHA-256 hash of a skill directory:

1. All files under the skill directory are collected recursively, excluding transient entries (`node_modules`, `.git`, `__pycache__`, `.DS_Store`, `.vellum-skill-run`).
2. Files are sorted by relative path to ensure deterministic ordering regardless of filesystem traversal order.
3. For each file: the normalized relative path, a null byte, the file content length, a null byte, the full file content, and a newline are fed into the hash.
4. The result is a canonical string: `v1:<hex-sha256>`.

### Version invalidation

When a skill's source files change (any file added, removed, or modified), the hash changes. Version-specific trust rules with the old hash no longer match, and the user is re-prompted. This protects against:

- **Supply-chain attacks**: A malicious update to a managed or workspace skill cannot silently inherit previous approvals.
- **Accidental drift**: Editing a skill's tool scripts invalidates stale approvals, ensuring the user reviews the new behavior.

### Choosing between version-specific and any-version rules

| Approval type    | Rule pattern                       | Behavior                                                                     |
| ---------------- | ---------------------------------- | ---------------------------------------------------------------------------- |
| Version-specific | `skill_load:my-skill@v1:abc123...` | Only this exact version is auto-allowed. Any code change triggers re-prompt. |
| Any-version      | `skill_load:my-skill`              | All versions of this skill are auto-allowed. No re-prompt on code changes.   |

Version-specific rules are more secure but require re-approval after every skill update. Any-version rules are more convenient but grant persistent access regardless of code changes.

## Skill Source Mutation Protection

Writing to skill source files is treated as a **high-risk** operation by the risk classifier. The `isSkillSourcePath()` function detects whether a file path falls under any known skill directory:

- **Managed skills**: `~/.vellum/workspace/skills/`
- **Bundled skills**: The application's built-in `bundled-skills/` directory
- **Workspace skills**: Project-local skill directories
- **Extra skills**: Additional roots configured by the user

When `file_write`, `file_edit`, `host_file_write`, or `host_file_edit` targets a path inside any of these directories, the risk level is escalated from its normal level (typically Medium) to **High**. High-risk operations always require user approval (only containerized bash is auto-allowed at runtime for high-risk operations).

This escalation prevents the agent from modifying skill code without explicit user consent. Since modifying a skill's source could grant the agent new capabilities or alter existing tool behavior, such mutations are treated as a privilege-escalation vector.

### Path normalization and symlink safety

The path classifier resolves symlinks before checking paths against skill root directories. This prevents bypass through:

- Symlinked parent directories that map into skill roots
- Relative paths with redundant segments (e.g., `./foo/../skills/my-skill/tool.ts`)
- Unnormalized paths that lexically differ from the canonical form

The `normalizeFilePath()` function walks up the directory tree to find the nearest existing ancestor, resolves it via `realpathSync`, and re-appends the remaining segments.

## Strict Threshold (`autoApproveUpTo: "none"`)

When the gateway threshold is set to `"none"`, **all** tool actions require a matching trust rule or explicit approval. There is no implicit auto-allow for any risk level. This means:

- Low-risk tools that would normally auto-execute at the default threshold (e.g., `file_read`, `web_search`) will prompt unless a trust rule allows them.
- `skill_load` requires an explicit rule match, even though it is classified as low risk.
- The **starter bundle** can be accepted to seed common safe rules and reduce prompt noise.

### Starter approval bundle

The starter bundle is an opt-in set of allow rules for read-only tools that most users would approve individually. Accepting the bundle seeds these rules at once:

| Tool             | Pattern             |
| ---------------- | ------------------- |
| `file_read`      | `file_read:**`      |
| `glob`           | `glob:**`           |
| `grep`           | `grep:**`           |
| `list_directory` | `list_directory:**` |
| `web_search`     | `web_search:**`     |
| `web_fetch`      | `web_fetch:**`      |

Acceptance is idempotent and recorded in `trust.json`. The bundle does not include any tools that mutate the filesystem or execute arbitrary code.

## Execution Targets

Tools can execute in two contexts:

| Target    | Description                                                                            |
| --------- | -------------------------------------------------------------------------------------- |
| `sandbox` | Isolated execution within `~/.vellum/workspace` (Docker container or OS-level sandbox) |
| `host`    | Direct execution on the host machine                                                   |

Trust rules can include an `executionTarget` field to bind the rule to a specific context. A rule without `executionTarget` matches both sandbox and host invocations.

Permission prompts include the `executionTarget` field so the user can see where the action will execute before approving it.

## Troubleshooting

### "Why am I being re-prompted after editing a skill?"

When you modify any file in a skill's directory, the version hash changes. If your trust rules use version-specific patterns (e.g., `skill_load:my-skill@v1:abc123...`), the old rule no longer matches the new hash. The system re-prompts to ensure you approve the updated skill.

**Fix**: Either re-approve the skill (which creates a new version-specific rule), or create an any-version rule (`skill_load:my-skill`) if you trust all future versions.

### "Why does file_write to my skill directory require high-risk approval?"

Writing to skill source paths is classified as high risk because it could alter the agent's capabilities. This is a deliberate security measure.

**Fix**: If you trust the operation, approve it. To permanently allow it, select "Always allow". Note that high-risk file operations will still prompt for each invocation since runtime auto-allow only applies to containerized bash.

### "Why is everything prompting?"

When `autoApproveUpTo` is set to `"none"`, every tool action requires an explicit trust rule or approval. There is no implicit auto-allow for any risk level.

**Fix**: Accept the starter approval bundle to seed common safe rules. Then approve additional tools as needed — each approval creates a persistent trust rule. Alternatively, raise `autoApproveUpTo` to `"low"` to auto-approve low-risk tools.

### "Why does skill_load prompt at some thresholds but not others?"

At the default threshold (`"low"`), `skill_load` may be auto-allowed by system default rules (e.g., `skill_load:*` at priority 100). At `"none"`, low-risk auto-allow is disabled, so an explicit rule is needed.

**Fix**: Create a rule for the specific skill (version-specific or any-version) or accept the starter bundle if it covers your needs.

### "How do I see what trust rules are currently active?"

Trust rules are stored in `~/.vellum/protected/trust.json`. You can inspect this file directly. Rules with `default:` prefixed IDs are system defaults; rules with UUID IDs are user-created.

### "A skill tool keeps prompting even though I approved it."

Check whether the rule has the correct `executionTarget` — a rule scoped to `sandbox` will not match a tool running on `host`.

## Inline Command Expansions

Skills can embed dynamic content by using the **inline command expansion** syntax. When a skill containing these tokens is loaded, each token is executed and replaced with its output before the skill body is delivered to the model. The syntax is shown in the fenced block below.

This syntax is intentionally compatible with the convention established by [inline skill commands](https://x.com) for portable cross-agent skill authoring. Vellum adopts the exact same token format so that externally authored skills load without rewriting — but applies stricter execution constraints.

### Syntax

The canonical syntax is:

```
!`command`
```

Where `command` is any shell command string. The exclamation mark immediately precedes the opening backtick with no whitespace in between. Examples:

```markdown
Current branch: !`git branch --show-current`
Recent changes: !`git log --oneline -5`
Project info: !`cat package.json | jq '.name, .version'`
```

Tokens inside fenced code blocks (` ``` ` or `~~~`) are **not** expanded — they are treated as documentation examples. This allows skills to safely include syntax examples without triggering execution.

### Parsing rules

The parser (`parseInlineCommandExpansions`) enforces fail-closed semantics:

| Condition                                         | Behavior               |
| ------------------------------------------------- | ---------------------- |
| Well-formed token outside fenced code             | Parsed as an expansion |
| Token inside a fenced code block                  | Skipped (not expanded) |
| Empty command text (no content between backticks) | Rejected as malformed  |
| Whitespace-only command text                      | Rejected as malformed  |
| Unmatched opening (no closing backtick found)     | Rejected as malformed  |
| Nested backticks inside command text              | Rejected as malformed  |

Malformed tokens do not silently pass through — they are collected as errors and logged. If a skill body contains any malformed tokens, the valid tokens are still expanded, but the errors are reported for diagnostics.

### Feature flag

Inline command expansion is gated by the `inline-skill-commands` feature flag (key: `inline-skill-commands`). The flag defaults to **enabled**.

When the flag is disabled and a skill contains inline command expansion tokens, `skill_load` returns an error rather than delivering unexpanded tokens to the model. This fail-closed behavior prevents the LLM from seeing raw expansion tokens and attempting to interpret them.

### Approval model

Skills with inline command expansions use a separate permission namespace: `skill_load_dynamic:*`. This ensures they do not silently inherit the permissive default `skill_load:*` allow rule.

When a user is prompted to approve a dynamic skill load, the allowlist options are:

| Option         | Pattern                                     | Behavior                                                                                            |
| -------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Version-pinned | `skill_load_dynamic:<id>@<transitive-hash>` | Approved for this exact version only. Any change to the skill or its includes invalidates the rule. |
| Any-version    | `skill_load_dynamic:<id>`                   | Approved for all versions of this skill.                                                            |

The transitive hash covers the skill's own content plus all included skills, so a change anywhere in the dependency graph triggers re-approval for version-pinned rules.

### v1 execution limits

In the initial implementation, inline command execution enforces these constraints:

| Constraint       | Value                                                   |
| ---------------- | ------------------------------------------------------- |
| Execution target | Sandbox only (no host fallback)                         |
| Network access   | Off (no outbound connections)                           |
| Environment      | Sanitized (no API keys, tokens, or credentials)         |
| Timeout          | 10 seconds per command                                  |
| Output cap       | 20,000 characters (truncated with `[output truncated]`) |
| Binary output    | Rejected if >10% non-printable characters               |
| ANSI sequences   | Stripped before output processing                       |
| stderr           | Discarded (only stdout is captured)                     |

Commands that fail (timeout, non-zero exit, spawn failure, binary output) produce a deterministic stub in the rendered body rather than leaking raw error output:

```
<inline_skill_command index="0">[inline command unavailable: command timed out]</inline_skill_command>
```

### Eligible skill sources

Only **bundled**, **managed**, and **workspace** skills may use inline command expansions. Third-party **extra** skill sources are explicitly rejected — `skill_load` returns an error if an extra-source skill contains inline expansion tokens.

| Source      | Eligible | Reason                                 |
| ----------- | -------- | -------------------------------------- |
| `bundled`   | Yes      | Shipped with the application, trusted  |
| `managed`   | Yes      | User-installed, subject to approval    |
| `workspace` | Yes      | Project-local, subject to approval     |
| `extra`     | No       | Third-party roots, out of scope for v1 |

### Fail-closed summary

The system fails closed at every layer:

1. **Flag off** — skill_load returns an error, tokens never reach the model.
2. **Malformed syntax** — rejected by the parser, logged as errors.
3. **Unsupported source** — skill_load returns an error for extra-source skills.
4. **Command failure** — deterministic stub replaces the token, no raw stderr.
5. **No permission** — `skill_load_dynamic:*` namespace requires explicit approval.
