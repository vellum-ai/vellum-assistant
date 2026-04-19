---
name: watcher
description: Create and manage polling watchers that monitor external services (Gmail, Google Calendar, GitHub, Linear, Outlook) for events and process them with custom action prompts
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "👀"
  vellum:
    display-name: "Watcher"
---

Create and manage watchers that poll external services for events and process them with an action prompt.

## Concepts

- **Provider** - The external service to poll (e.g. "gmail"). Each provider defines how to fetch and parse events.
- **Action prompt** - LLM instructions for handling detected events. Sent along with event data to a background conversation.
- **Poll interval** - How often to check for new events (minimum 15 seconds, default 60 seconds).
- **Digest** - Summary of recent watcher activity, grouped by watcher with time-based filtering.

## Lifecycle

1. Create a watcher with `assistant watchers create`, specifying a name, provider, and action prompt.
2. The system polls the provider at the configured interval.
3. Detected events are processed according to the action prompt.
4. Use `assistant watchers digest` to review recent activity.

## Available Commands

### Create a watcher

```
assistant watchers create \
  --name <name> \
  --provider <provider> \
  --action-prompt <prompt> \
  [--poll-interval <ms>] \
  [--config <json>] \
  [--credential-service <service>]
```

| Flag                   | Required | Description                                                                         |
| ---------------------- | -------- | ----------------------------------------------------------------------------------- |
| `--name`               | Yes      | A human-readable name for this watcher (e.g. "My Gmail")                            |
| `--provider`           | Yes      | The provider to poll (see Available Providers below)                                |
| `--action-prompt`      | Yes      | Instructions for the LLM on how to handle detected events                           |
| `--poll-interval`      | No       | How often to poll in milliseconds. Defaults to 60000 (1 minute). Minimum 15000      |
| `--config`             | No       | Provider-specific configuration as JSON (e.g. filter criteria)                      |
| `--credential-service` | No       | Override the credential service to use. Defaults to the provider's required service |

**Example:**

```bash
assistant watchers create \
  --name "My Gmail" \
  --provider gmail \
  --action-prompt "Summarize new emails and notify me if anything is urgent"
```

### List watchers

```
assistant watchers list [--id <watcherId>] [--enabled-only]
```

| Flag             | Required | Description                                                       |
| ---------------- | -------- | ----------------------------------------------------------------- |
| `--id`           | No       | Show detailed info for a specific watcher including recent events |
| `--enabled-only` | No       | Only show enabled watchers                                        |

**Example:**

```bash
# List all watchers
assistant watchers list

# Show details for a specific watcher
assistant watchers list --id abc123
```

### Update a watcher

```
assistant watchers update <watcherId> \
  [--name <name>] \
  [--action-prompt <prompt>] \
  [--poll-interval <ms>] \
  [--enabled | --disabled] \
  [--config <json>]
```

| Flag              | Required | Description                                           |
| ----------------- | -------- | ----------------------------------------------------- |
| `<watcherId>`     | Yes      | The ID of the watcher to update (positional argument) |
| `--name`          | No       | New name for the watcher                              |
| `--action-prompt` | No       | New action prompt for event processing                |
| `--poll-interval` | No       | New poll interval in milliseconds (minimum 15000)     |
| `--enabled`       | No       | Enable the watcher                                    |
| `--disabled`      | No       | Disable the watcher                                   |
| `--config`        | No       | New provider-specific configuration as JSON           |

**Example:**

```bash
# Change the action prompt
assistant watchers update abc123 --action-prompt "Flag urgent emails and ignore newsletters"

# Disable a watcher temporarily
assistant watchers update abc123 --disabled
```

### Delete a watcher

```
assistant watchers delete <watcherId>
```

Permanently deletes a watcher and all its event history.

**Example:**

```bash
assistant watchers delete abc123
```

### View watcher digest

```
assistant watchers digest [--id <watcherId>] [--hours <n>] [--limit <n>]
```

| Flag      | Required | Description                                                                          |
| --------- | -------- | ------------------------------------------------------------------------------------ |
| `--id`    | No       | Filter to events from a specific watcher. If omitted, shows events from all watchers |
| `--hours` | No       | How many hours back to look. Defaults to 24                                          |
| `--limit` | No       | Maximum number of events to return. Defaults to 50                                   |

**Example:**

```bash
# See all watcher activity from the last 24 hours
assistant watchers digest

# See activity from a specific watcher over the last 8 hours
assistant watchers digest --id abc123 --hours 8
```

## Available Providers

| Provider           | Description                                        |
| ------------------ | -------------------------------------------------- |
| `gmail`            | Monitor a Gmail inbox for new emails               |
| `google-calendar`  | Monitor Google Calendar for new or updated events  |
| `github`           | Monitor GitHub for repository activity             |
| `linear`           | Monitor Linear for issue updates                   |
| `outlook`          | Monitor an Outlook inbox for new emails            |
| `outlook-calendar` | Monitor Outlook Calendar for new or updated events |

## Usage Notes

- Use `assistant watchers create` when the user wants to monitor an external source (e.g. "watch my Gmail for important emails").
- `assistant watchers digest` is the go-to command when the user asks "what happened with my email?" or similar questions about watcher activity.
- Watchers can be enabled/disabled via `assistant watchers update` without deleting them -- use `--disabled` to pause and `--enabled` to resume.
- Each provider requires appropriate credentials to be configured. The `--credential-service` flag can override the default credential service if needed.
