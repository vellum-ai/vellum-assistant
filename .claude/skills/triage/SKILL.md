---
name: triage
description: >
  Look up Sentry events and log reports for a user or assistant, then cross-reference with Linear issues to produce a triage summary.
---

# Triage — Sentry Event Lookup and Incident Summary

Search Sentry for recent errors, log report attachments, and crash events related to a specific user, assistant, or device. Cross-reference findings with Linear issues to produce a concise triage summary.

The user may pass `$ARGUMENTS` as any combination of:
- A user name or email (searches the `user_identifier` tag)
- An assistant ID (searches the `assistant_id` tag)
- A device ID (searches the `device_id` tag)
- A conversation/session ID (searches `conversation_id` / `session_id` tags)
- A time range like "last 24h" or "last 7d" (defaults to last 24 hours)
- A keyword or error message to narrow the search

If `$ARGUMENTS` is empty, search for all recent unresolved issues across both projects.

## Sentry Projects

There are two Sentry projects in the `vellum` organization:

| Project slug              | What it covers                                    |
|---------------------------|---------------------------------------------------|
| `vellum-assistant-macos`  | macOS desktop app crashes, UI errors, MetricKit reports |
| `vellum-assistant-brain`  | Daemon/assistant runtime errors, LLM failures, agent loop issues |

Log report attachments (user-submitted `.tar.gz` files containing daemon logs) are routed to `vellum-assistant-brain` when the report reason is assistant behavior, and to `vellum-assistant-macos` otherwise.

## Available Tags for Filtering

### Brain project (`vellum-assistant-brain`)
- `assistant_id` — the assistant instance identifier
- `conversation_id` — conversation/session identifier
- `session_id` — mirrors conversation_id
- `message_count` — number of messages at time of error
- `user_identifier` — stable per-user identifier (guardian principal ID)

### macOS project (`vellum-assistant-macos`)
- `device_id` — SHA-256 hashed hardware UUID
- `assistant_id` — connected assistant identifier
- `os_version` — macOS version string

## Steps

### 1. Parse the input

Extract identifiers, time range, and keywords from `$ARGUMENTS`. Determine which tags to filter by. If a plain name is given, use it as `user_identifier`. If an ID-like string is given, try it as `assistant_id` or `conversation_id`.

### 2. Search both Sentry projects for matching issues

Use the Sentry MCP tools to search for issues in both projects. Run both searches in parallel.

**Brain project:**
```
mcp__sentry__search_issues with:
  - organization_slug: "vellum"
  - project_slug: "vellum-assistant-brain"
  - query: build from tags, e.g. "assistant_id:<id>" or "user_identifier:<name>"
  - sort_by: "date" (most recent first)
```

**macOS project:**
```
mcp__sentry__search_issues with:
  - organization_slug: "vellum"
  - project_slug: "vellum-assistant-macos"
  - query: build from tags, e.g. "assistant_id:<id>" or "device_id:<hash>"
  - sort_by: "date" (most recent first)
```

If no tag filters were extracted from the input, search for `is:unresolved` in both projects to get recent open issues.

### 3. Get details for top issues

For the most relevant issues (up to 5 per project), fetch details:

```
mcp__sentry__get_issue_details with:
  - issue_id: <issue_id from search results>
```

### 4. Search for related events

For each top issue, search for recent events to understand frequency and context:

```
mcp__sentry__search_issue_events with:
  - organization_slug: "vellum"
  - project_slug: <project>
  - issue_id: <issue_id>
```

### 5. Check for log report attachments

For events that may have log report attachments (look for events with fingerprints containing "log_report"), fetch the attachment:

```
mcp__sentry__get_event_attachment with:
  - organization_slug: "vellum"
  - project_slug: <project>
  - event_id: <event_id>
```

If a `.tar.gz` attachment is found, summarize the key contents (error patterns, stack traces, timestamps).

### 6. Extract tag values for correlation

For issues with high event counts, check what tag values are most common to identify affected users/devices:

```
mcp__sentry__get_issue_tag_values with:
  - organization_slug: "vellum"
  - project_slug: <project>
  - issue_id: <issue_id>
  - tag_key: "assistant_id" (or "device_id", "user_identifier", "os_version")
```

### 7. Cross-reference with Linear

Search Linear for related issues that may already be tracking the problem:

```
mcp__linear-server__search_documentation with:
  - query: <error message or issue title from Sentry>
```

Also search for issues directly:

```
mcp__linear-server__list_issues with:
  - query: <error keywords>
```

### 8. Produce the triage summary

Output a structured summary:

```
## Triage Summary

**Query**: <what was searched for>
**Time range**: <period covered>
**Projects searched**: vellum-assistant-brain, vellum-assistant-macos

### Issues Found

#### [Brain/macOS] <Issue title>
- **Sentry issue**: <link or ID>
- **Status**: unresolved / resolved / ignored
- **Events**: <count> in the last <period>
- **Affected users/devices**: <tag breakdown>
- **Error**: <brief description of the error>
- **Log report**: <summary of attachment if found, or "None">
- **Linear issue**: <linked Linear issue if found, or "None found">

### Recommendations
- <actionable next steps based on findings>
```

### 9. Offer follow-up actions

After presenting the summary, offer:
- "Would you like me to create a Linear issue for any of these?"
- "Would you like me to dig deeper into a specific issue?"
- "Would you like me to check a different time range or user?"
