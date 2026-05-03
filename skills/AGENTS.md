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
  - **Security analysis note**: Skills that demonstrate `curl`, `wget`, or other network tool usage against specific API endpoints do not introduce new capabilities — the assistant already has outbound network access via `bash`. These are instructions for using an existing tool, not a new attack surface. See [`assistant/docs/architecture/security.md#skill-threat-model`](../assistant/docs/architecture/security.md) for the full threat model.

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

  ### `--actions` — custom action buttons

  Use `--actions` to define custom buttons on a `ui request` surface. Each action has an `id`, `label`, and optional `variant` (`"primary"`, `"danger"`, or `"secondary"`). The user's chosen action is returned in `actionId`.

  ```bash
  # Present a multi-option surface with custom actions
  RESULT=$(assistant ui request \
    --payload '{"message":"The staging deploy found 3 failing tests."}' \
    --title "Deploy decision" \
    --actions '[
      {"id":"deploy_anyway","label":"Deploy Anyway","variant":"danger"},
      {"id":"fix_first","label":"Fix Tests First","variant":"primary"},
      {"id":"skip","label":"Skip This Deploy","variant":"secondary"}
    ]' \
    --json)

  STATUS=$(echo "$RESULT" | jq -r '.status')
  ACTION=$(echo "$RESULT" | jq -r '.actionId')

  if [ "$STATUS" = "submitted" ]; then
    case "$ACTION" in
      deploy_anyway)
        run_deploy --force
        ;;
      fix_first)
        echo "Aborting deploy. Fix the tests and re-run."
        exit 0
        ;;
      skip)
        echo "Deploy skipped."
        exit 0
        ;;
    esac
  elif [ "$STATUS" = "cancelled" ]; then
    REASON=$(echo "$RESULT" | jq -r '.cancellationReason // "unknown"')
    if [ "$REASON" = "user_dismissed" ]; then
      echo "User dismissed the prompt."
    else
      echo "Surface cancelled (reason: $REASON). No action taken."
    fi
  else
    echo "Timed out. No action taken."
  fi
  ```

  Reserved action IDs are used internally and are rejected by `--actions` validation. There are two categories:

  - **Lifecycle events** (`selection_changed`, `content_changed`, `state_update`) — non-terminal events that are silently swallowed without resolving the pending request.
  - **Cancellation triggers** (`cancel`, `dismiss`) — resolve the pending request as `cancelled` (instead of `submitted`).

  ### Status and cancellation reason branching reference

  Both `ui confirm` and `ui request` return a `status` field in `--json` mode. However, the `cancellationReason` field is only available in `ui request --json` output. The `ui confirm` command uses the simpler exit-code pattern (0 = confirmed, 1 = denied/cancelled/timed out) and its `--json` output includes `ok`, `confirmed`, `status`, `actionId`, `surfaceId`, and optional `decisionToken`/`summary` — but not `cancellationReason`.

  | Status | Meaning | Typical action |
  |--------|---------|----------------|
  | `submitted` | User completed the interaction (confirmed, denied, or submitted form) | For `ui confirm`: exit code 0 = confirmed, 1 = denied. For `ui request`: check `actionId` or `submittedData`. |
  | `cancelled` | Surface was cancelled | For `ui confirm`: exit code 1 — abort gracefully. For `ui request`: check `cancellationReason` to determine why. |
  | `timed_out` | No response within the timeout window | Abort safely. Do not proceed — treat as a non-confirmation. |

  **Cancellation reasons** (`ui request` only): The `cancellationReason` field distinguishes user-driven from operational cancellations. This field is only present in `ui request --json` output.

  | `cancellationReason` | Category | Meaning |
  |----------------------|----------|---------|
  | `user_dismissed` | User-driven | User explicitly closed the surface. Treat as a deliberate "no." |
  | `no_interactive_surface` | Operational | No interactive UI is available (headless/API channel). Consider a fallback. |
  | `conversation_not_found` | Operational | Target conversation could not be located. Check the conversation ID. |
  | `resolver_unavailable` | Operational | UI transport is disconnected (e.g. desktop client dropped). May be transient. |
  | `resolver_error` | Operational | UI resolver threw an unexpected error. Log for investigation. |

  **Canonical branching pattern for `ui request`** — for scripts that need to distinguish user dismissal from operational failures:

  ```bash
  RESULT=$(assistant ui request \
    --payload '{"message":"Confirm the operation"}' \
    --title "Operation" \
    --json)

  STATUS=$(echo "$RESULT" | jq -r '.status')
  case "$STATUS" in
    submitted)
      # Handle based on actionId or submittedData
      ;;
    cancelled)
      REASON=$(echo "$RESULT" | jq -r '.cancellationReason // "unknown"')
      if [ "$REASON" = "user_dismissed" ]; then
        echo "User chose not to proceed."
        exit 0
      fi
      # Operational cancellation — log and decide on recovery
      echo "Surface cancelled: $REASON" >&2
      exit 1
      ;;
    timed_out)
      echo "Timed out — aborting."
      exit 1
      ;;
    *)
      echo "Unexpected status: $STATUS" >&2
      exit 1
      ;;
  esac
  ```

  For `ui confirm`, use the simpler exit-code pattern (see the `ui confirm` section above) or check `status` and `confirmed` fields in `--json` mode. Do not branch on `cancellationReason` with `ui confirm` — it is not included in the output.

  **Decision token**: When the user affirmatively confirms (action `"confirm"`), the JSON output includes a `decisionToken` field — a short-lived, non-authoritative token encoding metadata about the decision (conversation, surface, action, timestamps). Use it for audit trails and cross-system correlation. The token is informational only and does not grant any capability. It is absent for deny, cancel, and timeout outcomes.

  ### Conversation ID resolution

  Inside a skill context, the conversation ID is auto-resolved from `__SKILL_CONTEXT_JSON` (set by the skill sandbox runner). Override with `--conversation-id <id>` if needed — run `assistant conversations list` to find available IDs.

  ### Timeouts

  Both commands accept `--timeout <ms>` (default: 300000ms / 5 minutes). Choose a timeout appropriate to the operation — shorter for simple confirmations, longer for complex forms. On timeout, the surface auto-cancels and the CLI exits with `status: "timed_out"`.

- **Vellum-specific extensions**
  - If you must do something Vellum-system specific, use the `metadata` field to connect the skill in a structured way
