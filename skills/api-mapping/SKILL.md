---
name: api-mapping
description: Record and analyze API surfaces of web services
compatibility: "Designed for Vellum personal assistants"
metadata: {"emoji":"🗺️","vellum":{"display-name":"API Mapping","user-invocable":true}}
---

You can record and analyze the API surface of any web service using the `map` CLI.

## CLI Setup

**IMPORTANT: Always use `host_bash` (not `bash`) for all `map` commands.** The API mapping CLI needs host access for Chrome CDP, network recording, and browser automation — none of which are available inside the sandbox.

`map` is a standalone CLI tool installed at `~/.vellum/bin/map`. It should already be on your PATH. If `map` is not found, prepend `PATH="$HOME/.vellum/bin:$PATH"` to the command. Do NOT search for the binary or try to discover how the CLI works. Just run the commands as documented below.

## Typical Flow

When the user wants to map a web service's API (e.g. "Map the Notion API" or "Figure out how Figma's API works"):

1. **Ask about the objective** — Ask the user: "What service do you want to map?" and "What are you trying to build or integrate with?" This helps focus the recording on the relevant parts of the API surface.

2. **Choose mode** — Ask the user: "Should I browse automatically, or do you want to drive?" This determines whether to use auto mode or manual mode:
   - **Auto mode**: The CLI launches a headless browser, navigates the service, and records API calls automatically. Best for broad discovery.
   - **Manual mode**: A Chrome window opens for the user to interact with the service while the CLI records all API traffic in the background. Best for capturing a specific workflow.

3. **Run the mapping** — Execute the appropriate `map` command:
   - Auto mode: `map <domain> --json`
   - Manual mode: `map <domain> --manual --json`
   - For longer sessions: `map <domain> --duration 120 --json`

4. **Wait for recording to complete** — In auto mode, the CLI will browse and record for the default duration (60 seconds) then stop. In manual mode, the CLI blocks until the user closes the browser or presses Ctrl+C. The command outputs a JSON summary of all discovered endpoints.

5. **Analyze the API map** — Review the output and present findings to the user:
   - List discovered endpoints grouped by resource type (e.g., `/api/v1/users`, `/api/v1/documents`)
   - Note authentication patterns (Bearer tokens, cookies, API keys)
   - Identify CRUD operations and their HTTP methods
   - Highlight any WebSocket or streaming endpoints
   - Call out rate limiting headers or pagination patterns

6. **Offer next steps** — Based on the discovered API surface, offer to:
   - Create CLI tools that wrap the discovered endpoints
   - Generate TypeScript types from observed request/response payloads
   - Build a focused integration for the user's specific use case
   - Re-record with a longer duration or manual mode to capture more endpoints

## Important Behavior

- **Be proactive.** If the user names a service, start mapping immediately rather than asking unnecessary clarifying questions. Ask about mode preference, then go.
- **Always use `--json` flag** on all commands for reliable parsing.
- **Present findings clearly.** Group endpoints logically, show HTTP methods, and highlight the most useful ones for the user's stated objective.
- **Suggest manual mode for authenticated services.** If auto mode returns mostly auth redirects or login pages, suggest switching to manual mode so the user can log in first.
- **Handle errors gracefully.** If the domain is unreachable or the recording captures no API calls, suggest checking the domain, trying manual mode, or increasing the duration.

## Command Reference

```
map <domain> --json                        # Auto mode: browse and record API calls (default 60s)
map <domain> --manual --json               # Manual mode: user drives the browser, CLI records
map <domain> --duration <secs> --json      # Auto mode with custom duration
map <domain> --manual --duration <secs> --json  # Manual mode with custom timeout
```

## Example Interaction

**User**: "Map the Notion API"

1. Ask: "What are you trying to build with Notion? And should I browse automatically, or do you want to drive the browser?"
2. User says: "I want to build a CLI to manage my pages. I'll drive."
3. `map notion.com --manual --json` -> Chrome window opens
4. Tell user: "A Chrome window is open. Log into Notion and do a representative workflow — create a page, edit it, maybe move it. I'll record all API calls in the background. Close the browser when you're done."
5. User closes browser -> CLI outputs discovered endpoints
6. Present findings: "I found 14 API endpoints. Here are the key ones for page management:
   - `POST /api/v3/getSpaces` — lists workspaces
   - `POST /api/v3/syncRecordValues` — fetches page content
   - `POST /api/v3/submitTransaction` — creates/updates pages
   - `POST /api/v3/enqueueTask` — async operations (export, duplicate)
   Authentication: Cookie-based session with `token_v2`."
7. Offer: "Want me to create a CLI tool that wraps these endpoints for managing Notion pages?"
