# A2A Social Extension Demo -- Coffee Run

Proves the Vellum social extension wire format on top of the official A2A SDK. Exercises all four `response_basis` values (`standing_preference`, `confirmed`, `inferred`, `unreachable`) across four mock peers with different HITL strategies. The full demo runs in ~15 seconds.

## Quick start (solo)

```bash
cd a2a-demo && bun install

# Terminal 1: Start mock peers
bun run peers:start

# Terminal 2: Build UI and start your assistant
bun run dev

# Open http://localhost:3000 and click "Start coffee run"
```

Or use the single-command supervisor which starts everything in one process:

```bash
cd a2a-demo && bun install
bun run demo
# Open http://localhost:3000 and click "Start coffee run"
```

## Run with a friend

Both people check out the branch and `bun install` in `a2a-demo/`.

**Friend** starts their assistant with identity config:

```bash
ASSISTANT_NAME="Friend's Assistant" \
ASSISTANT_ID="friend-assistant-1" \
COFFEE_RESPONSE="Large cold brew please!" \
PUBLIC_BASE_URL=http://<their-ip>:3000 \
bun run dev
```

**You** edit `connections.json`: change one peer entry's `peer_base_url` and `peer_agent_card_url` to `http://<friend-ip>:3000`.

Then start peers and your assistant:

```bash
bun run peers:start  # terminal 1
bun run dev          # terminal 2
```

Click "Start coffee run" -- that peer's card now shows whatever their assistant returns.

**Important**: `PUBLIC_BASE_URL` must be set to a reachable address (not `localhost`) on the friend's machine.

## Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `3000` | Server port |
| `PUBLIC_BASE_URL` | `http://localhost:$PORT` | Externally-reachable URL for agent card |
| `ASSISTANT_NAME` | `Demo Assistant` | Name in agent card |
| `ASSISTANT_ID` | `demo-assistant-1` | Assistant identifier |
| `COFFEE_RESPONSE` | `I appreciate the offer!` | What this assistant replies when asked |
| `RESPONSE_STRATEGY` | `standing_preference` | How this assistant responds |

## What each mock peer exercises

| Peer | Port | Strategy | `response_basis` | HITL states |
|------|------|----------|-------------------|-------------|
| Sarah | 3010 | Standing preference | `standing_preference` | none |
| Jake | 3011 | HITL -> confirm | `confirmed` | `awaiting_human_input` |
| Maria | 3012 | HITL -> stale -> infer | `inferred` | `awaiting_human_input`, `awaiting_human_input_stale` |
| Priya | 3013 | HITL -> unreachable | `unreachable` | `awaiting_human_input` |

## Architecture

The demo is built on the [A2A JS SDK](https://github.com/nicholasgriffintn/a2a-js) and layers Vellum's social extension on top.

**SDK usage:**
- `ClientFactory` and `ClientFactoryOptions` create A2A clients from a base URL by discovering the agent card at `/.well-known/agent-card.json`
- `DefaultRequestHandler` + `InMemoryTaskStore` handle incoming A2A JSON-RPC requests
- `UserBuilder.noAuthentication` disables auth for the demo
- `VellumSocialExecutor` implements `AgentExecutor` to produce task status updates, artifacts, and HITL working states

**Vellum extension layers:**
- `DataPart` on message and artifact parts carries `x-vellum-social-v1` payloads (request, response, and working/HITL data)
- `VellumSocialInterceptor` (a `CallInterceptor` wired via `ClientFactory`) injects extension data into outgoing `sendMessage`/`sendMessageStream` calls
- `VellumAgentCard` type extends `AgentCard` with `x-vellum-social-v1: true`
- Agent-card discovery checks for `x-vellum-social-v1` support before sending requests

## Demo time vs real time

Deadlines default to 15 seconds, and peer delays range from 0-8 seconds. In production the deadline would be minutes and HITL waits would be longer. The `deadlineSeconds` parameter on `POST /run/coffee` can be changed to adjust the demo pace.
