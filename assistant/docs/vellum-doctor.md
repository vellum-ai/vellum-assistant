# Vellum Doctor

Vellum Doctor is a platform-hosted diagnostic tool for investigating problems with a Vellum assistant.

> **Status:** Beta. Vellum Doctor is available in the web client for platform-hosted assistants; it is not available for self-hosted assistants.

## What it does

Doctor provides a separate diagnostic session where a guardian can describe an issue and receive an investigation that may include:

- Plain-language explanations of what the Doctor found.
- Tool calls with expandable technical details and outputs.
- Requests for approval before an operation runs.
- A backup prompt before an operation that may modify the assistant.
- Feedback prompts when an issue may need attention from the Vellum team.
- A session transcript that can be copied for follow-up or support.

Doctor is separate from the assistant's normal conversation. It is a support and diagnosis surface, not another assistant that builds a long-term relationship with the guardian.

## When to use it

Open Doctor when an assistant is not behaving as expected, especially when the cause could be a runtime problem, an integration or credential problem, a missing capability, a failed scheduled action, or a permission boundary.

The web client may show a **Go to Doctor** action in an operational error notice. Doctor can also be opened from the **Doctor** tab under the assistant's debug settings.

### Open Doctor from chat

The web client supports a slash command that opens the Doctor panel:

```text
/doctor
```

You can include the first message after the command:

```text
/doctor My assistant stopped responding after I connected Slack
```

The command navigates to Doctor instead of sending the text as a normal assistant turn. On a self-hosted assistant, Doctor is unavailable and the command does not start a Doctor session.

## Session lifecycle

A Doctor session follows this flow:

1. The web client creates a diagnostic session for the active assistant.
2. Doctor sends a greeting and opens a live event stream.
3. The guardian describes the issue and can send follow-up messages while the session is active.
4. Doctor streams assistant messages, tool activity, approval requests, backup prompts, and errors into the panel.
5. The session ends with either `completed` or `error` status.
6. The guardian can start a new session after a terminal state.

The web client can load the most recent persisted session when the Doctor panel opens. An active session can be resumed, including pending approval or backup prompts, and completed sessions remain available as history.

## Approval and backup prompts

Doctor can ask for confirmation before running an operation.

- **Allow once** approves the requested operation for the current prompt.
- **Always Allow** is available for `exec_command` requests and approves future execution requests in that session.
- **Deny** rejects the requested operation.
- **Show details** reveals the tool name, description, and input that Doctor received.

Before an operation that may modify the assistant, Doctor can ask whether to create a backup first:

- **Back up** creates the backup before continuing.
- **Skip** continues without that backup.

Approval and backup prompts are part of the session transcript, so the guardian can see which operations were proposed and how they were handled.

## Session history and transcripts

Doctor sessions are persisted against the assistant that they diagnose. The web client can retrieve the newest sessions and the ordered message ledger for a selected session.

A persisted session includes:

- Lifecycle status: `active`, `completed`, or `error`.
- Ordered user and Doctor messages.
- Tool calls and tool results.
- Approval, backup, feedback, status, and error entries.
- Message timestamps and counts.
- Token and estimated-cost totals returned by the platform API.

The **Copy Session** action serializes the visible session into text. Doctor's idle panel also warns that Doctor logs may be temporarily stored, so guardians should avoid entering secrets that are not necessary for diagnosis.

## Feedback and support handoff

Doctor can show a feedback prompt when the investigation identifies an issue that may be useful to the Vellum team. The feedback flow can include the Doctor session ID and a transcript file, subject to the diagnostics choice in the feedback form.

Sharing feedback is separate from approving a Doctor operation. A guardian can continue describing the issue while the feedback prompt is present.

## API reference

The platform API exposes Doctor under the assistant-scoped routes below. Requests use the same authentication options as the surrounding platform API.

| Operation        | Route                                                                           | Purpose                                                    |
| ---------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| List history     | `GET /v1/assistants/{assistant_id}/doctor/history/`                             | List persisted sessions, newest first.                     |
| Retrieve history | `GET /v1/assistants/{assistant_id}/doctor/history/{doctor_session_id}/`         | Retrieve one session and its ordered message ledger.       |
| Create session   | `POST /v1/assistants/{assistant_id}/doctor/sessions/`                           | Create a new diagnostic session and return its session ID. |
| Stream events    | `GET /v1/assistants/{assistant_id}/doctor/sessions/{session_id}/events/`        | Receive Doctor events over Server-Sent Events.             |
| Send message     | `POST /v1/assistants/{assistant_id}/doctor/sessions/{session_id}/messages/`     | Send a message to an active session.                       |
| Record outcome   | `POST /v1/assistants/{assistant_id}/doctor/sessions/{session_id}/user-outcome/` | Record whether Doctor solved the problem.                  |
| Delete session   | `DELETE /v1/assistants/{assistant_id}/doctor/sessions/{session_id}/`            | End and clean up a session.                                |

### Create a session

A successful create request returns:

```json
{
  "session_id": "doctor-session-id"
}
```

### Send a message

The message body requires non-empty `content` and can include an optional `source_event_id` for replay-safe delivery:

```json
{
  "content": "My assistant cannot send messages to Slack"
}
```

A successful request is accepted with HTTP `202` while the response arrives on the event stream.

### Record the user outcome

When Doctor asks whether it solved the problem, submit the answer to the session's outcome route:

```json
{
  "resolved": true
}
```

Use `false` when the problem was not resolved. The endpoint returns `200`, records the latest answer for the session, and works for both active and completed sessions.

### Event types

The event stream validates and handles these event types:

| Event                 | Meaning                                                         |
| --------------------- | --------------------------------------------------------------- |
| `message`             | A complete Doctor message.                                      |
| `message_delta`       | A streamed part of a Doctor message.                            |
| `tool_call`           | Doctor started a tool operation.                                |
| `tool_result`         | A tool operation returned output, including whether it failed.  |
| `approval_required`   | Doctor is waiting for an approval response.                     |
| `backup_prompt`       | Doctor is asking whether to create a backup before continuing.  |
| `feedback_prompt`     | Doctor is offering a feedback handoff.                          |
| `user_outcome_prompt` | Doctor is asking whether it solved the guardian's problem.      |
| `status`              | The session is active, completed, or in an error state.         |
| `error`               | The session encountered an error with a human-readable message. |

Malformed events and unknown event types are ignored by the web client rather than being treated as trusted Doctor output.

## Failure states and recovery

### No assistant is selected

Doctor cannot start without an active assistant. Hatch or select an assistant, then reopen the Doctor panel.

### Doctor is unavailable

Doctor is platform-hosted. Self-hosted assistants do not expose the Doctor tab or the `/doctor` command.

### Monthly session limit

The platform can reject session creation when the available Doctor sessions for the month have been used. The web client tells the guardian to try again next month.

### Service or connection failure

Session creation, message delivery, and event streaming can fail when the Doctor service or platform proxy is unavailable. The panel surfaces the returned error and ends the session when it cannot recover.

The event stream retries recoverable interruptions with a bounded reconnect policy. If the session has expired, its event history cannot be replayed, or the stream remains idle, the panel asks the guardian to start a new session.

### A tool operation fails

A failed tool result is shown in the transcript with its technical output. Doctor can continue investigating, ask for another action, or end the session with an error. A failed operation does not become a successful diagnosis merely because the session is still open.

## Source map

The implementation currently lives in the web client and platform API contract:

- `clients/web/src/domains/settings/pages/debug-page.tsx` exposes the Doctor tab.
- `clients/web/src/domains/settings/components/panels/doctor-panel.tsx` owns session creation, messaging, history, cleanup, and the panel UI.
- `clients/web/src/domains/settings/components/panels/use-doctor-sse.ts` owns the event stream, validation boundary, reconnect behavior, and replay handling.
- `clients/web/src/domains/settings/components/panels/doctor-event-schema.ts` defines the validated event contract.
- `clients/web/src/domains/settings/components/panels/doctor-event-handlers.ts` maps events into visible session entries.
- `clients/web/src/domains/settings/components/panels/doctor-history.ts` maps persisted messages and serializes copied transcripts.
- `clients/web/openapi-schemas/platform.yaml` defines the assistant-scoped Doctor routes and persisted session schemas.

The Vellum Assistant runtime does not provide a local Doctor CLI command. Doctor is a web and platform capability, not a command run inside a self-hosted assistant.
