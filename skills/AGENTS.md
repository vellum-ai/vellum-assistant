# Skills Contribution Guide

- **Skills must be self-contained and portable**
  - No interactive prompts. Use relative paths only.
  - Use `scripts/` for supporting logic with inline dependencies
  - When including code assets, utilities, or tools, load the [scripts best practices specification](https://agentskills.io/skill-creation/using-scripts.md) first
  - **External dependencies in Bun/TypeScript scripts**: pin versions directly in the import path (e.g., `import { Command } from "commander@13.1.0"`). Bun auto-installs missing packages at runtime when no `node_modules` directory is found. Do NOT add a `package.json` or `bun.lock` to skill directories - this disables Bun's auto-install behavior and breaks portability.
  - Do not install CLIs into Vellum or the host system; provide instructions for users to install external packages if needed
  - Do not create new assistant tools and reference them from SKILL.md - this couples skills to Vellum internals and breaks compatibility with other agent systems
  - Do not include a TOOLS.json file in skill directories - skills should rely on CLI tools in `scripts/`, not custom tool definitions

- **Follow the [Agent Skills specification](https://agentskills.io/specification)**
  - All skills must conform to the spec's SKILL.md format: required YAML frontmatter (`name`, `description`), optional fields (`license`, `compatibility`, `metadata`, `allowed-tools`), and Markdown body
  - The `name` field must match the parent directory name, use only lowercase alphanumeric characters and hyphens (1-64 chars), and must not start/end with a hyphen or contain consecutive hyphens
  - Use the spec's directory structure: `SKILL.md` at root, `scripts/` for executable code, `references/` for supplementary docs, `assets/` for static resources
  - Follow progressive disclosure: keep `description` keyword-rich for discovery (~100 tokens), keep `SKILL.md` body under 500 lines (< 5000 tokens recommended), and move detailed reference material to `references/`

- **API interactions use Vellum's outbound proxy**
  - Outbound network traffic from the bash tool is automatically intercepted by an outbound proxy in a manner that's transparent to the assistant
  - Update proxy settings so the bash tool can inject correct auth headers for approved domains
  - **Never instruct the assistant to ask for secrets in chat.** API keys, tokens, passwords, and webhook secrets must be collected via `credential_store prompt`, which provides a secure UI — the value never enters the conversation. Non-secret values (e.g., Client IDs, Account SIDs, usernames) can be collected conversationally. See existing skills (e.g., `twilio-setup`, `slack-app-setup`) for the pattern.

- **Write portable instructions**
  - Avoid referring to tools by specific names (prefer "Take a browser screenshot" over "Use browser_screen_grab")
  - It is fine to refer to tools/utils/etc. directly by name if it is bundled with the skill (likely in `scripts/`)
  - Use standard frontmatter according to the [Agent Skills specification](https://agentskills.io/specification) - linters validate this

- **Inline command expansions (`!`command``)**
  - First-party skills may use the interoperable `` !`command` `` syntax to embed dynamic content that is resolved at skill-load time (e.g., `` !`git branch --show-current` ``, `` !`cat package.json | jq '.version'` ``)
  - This syntax is intentionally compatible with the cross-agent inline skill command convention so that externally authored skills load in Vellum without rewriting
  - **Vellum's execution semantics are intentionally stricter than the tweet's host-shell behavior**: commands run only in the sandbox, with network off, sanitized environment, 10-second timeout, and stdout-only capture. Do not assume host-shell capabilities (network access, credential availability, interactive prompts)
  - Place documentation examples of the syntax inside fenced code blocks (`` ``` `` or `~~~`) — the parser skips tokens inside fences, so examples will not accidentally execute
  - Never use empty commands (`` !`` ``), whitespace-only commands, or unmatched backticks — these are rejected by the parser as malformed
  - The `inline-skill-commands` feature flag must be enabled for inline expansions to work. When the flag is off, skills containing expansion tokens fail closed at load time
  - Inline command expansions are only supported for `bundled`, `managed`, and `workspace` skill sources. Skills distributed as `extra` sources cannot use this syntax

- **User-gated actions (interactive confirmation/input)**

  Scripts that perform irreversible or high-risk operations (sending emails, deleting data, unsubscribing, making purchases) **must** gate execution on explicit user confirmation. Prose-only instructions in SKILL.md ("always ask the user first") are not sufficient — they rely on the LLM following the instruction, which is not guaranteed.

  Use the `assistant ui` CLI commands to present a blocking interactive surface and branch on the result. Two commands are available:

  ### `assistant ui confirm` — binary yes/no gate

  Use this for irreversible actions that need a simple go/no-go decision. The command exits `0` on confirm, `1` on deny/cancel/timeout.

  ```bash
  # Gate on user confirmation before sending an email
  if assistant ui confirm \
    --title "Send email" \
    --message "Send draft to jane@example.com — Subject: Q2 Report" \
    --confirm-label "Send" \
    --deny-label "Cancel"; then
    # User confirmed — proceed with the action
    assistant oauth request POST "/v1.0/me/messages/${DRAFT_ID}/send" \
      --provider microsoft-graph
  else
    echo "Send cancelled by user."
    exit 0
  fi
  ```

  For scripts that need to inspect the result (e.g. distinguish deny from timeout):

  ```bash
  RESULT=$(assistant ui confirm \
    --title "Delete records" \
    --message "Permanently delete 42 records from the archive?" \
    --confirm-label "Delete" \
    --deny-label "Keep" \
    --json)

  STATUS=$(echo "$RESULT" | jq -r '.status')
  CONFIRMED=$(echo "$RESULT" | jq -r '.confirmed')

  case "$STATUS" in
    submitted)
      if [ "$CONFIRMED" = "true" ]; then
        # User clicked "Delete" — proceed
        perform_deletion
      else
        echo "User denied the action."
      fi
      ;;
    cancelled)
      echo "User dismissed the prompt."
      ;;
    timed_out)
      echo "No response — timed out. Aborting."
      ;;
    *)
      echo "Unexpected status: $STATUS" >&2
      exit 1
      ;;
  esac
  ```

  ### `assistant ui request` — structured input/data collection

  Use this when you need more than a yes/no — e.g. collecting form data, presenting choices, or gathering parameters before executing an operation. Returns full JSON with user-submitted data.

  ```bash
  RESULT=$(assistant ui request \
    --payload '{"message":"Select accounts to archive","fields":[{"name":"accounts","type":"multi-select"}]}' \
    --surface-type form \
    --title "Archive accounts" \
    --json)

  STATUS=$(echo "$RESULT" | jq -r '.status')

  if [ "$STATUS" = "submitted" ]; then
    # Extract user-submitted data and proceed
    ACCOUNTS=$(echo "$RESULT" | jq -r '.submittedData.accounts')
    archive_accounts "$ACCOUNTS"
  elif [ "$STATUS" = "cancelled" ]; then
    echo "User cancelled."
  else
    echo "Request failed or timed out: $STATUS"
    exit 1
  fi
  ```

  ### Status branching reference

  Every `assistant ui` response includes a `status` field. Handle all three terminal states:

  | Status | Meaning | Typical action |
  |--------|---------|----------------|
  | `submitted` | User completed the interaction (confirmed, denied, or submitted form) | Check `actionId` to determine the action taken — e.g. `"confirm"` or `"deny"` for confirmations. For `ui confirm`, exit code 0 = confirmed, 1 = denied. |
  | `cancelled` | User dismissed the surface without choosing an action (e.g. closed the dialog) | Abort gracefully. Inform the user the action was skipped. |
  | `timed_out` | No response within the timeout window | Abort safely. Do not proceed — treat as a non-confirmation. |

  **Cancellation vs. failure**: A `cancelled` status means the user made a deliberate choice not to proceed — this is a normal outcome, not an error. Operational failures (IPC unavailable, invalid payload, no conversation context) surface as `ok: false` in JSON mode or a non-zero exit with an error message. Scripts should distinguish the two: cancellation is graceful, failure is exceptional.

  ### Conversation ID resolution

  Inside a skill context, the conversation ID is auto-resolved from `__SKILL_CONTEXT_JSON` (set by the skill sandbox runner). Override with `--conversation-id <id>` if needed — run `assistant conversations list` to find available IDs.

  ### Timeouts

  Both commands accept `--timeout <ms>` (default: 300000ms / 5 minutes). Choose a timeout appropriate to the operation — shorter for simple confirmations, longer for complex forms. On timeout, the surface auto-cancels and the CLI exits with `status: "timed_out"`.

- **Vellum-specific extensions**
  - If you must do something Vellum-system specific, use the `metadata` field to connect the skill in a structured way
