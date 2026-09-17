# Background task outcomes in live voice

The conversation's active live-voice session owns delivery of subagent updates
while the call is open. `injectMessageIntoParent` offers updates carrying
`subagentNotification` metadata to the existing `LiveVoiceSessionManager` before
enqueuing a generic parent turn. The manager only routes to its session with the
matching conversation ID. A closing session holds incoming updates for its
teardown handoff. Other conversations and fully closed calls retain the ordinary
parent delivery path.

The session keeps pending updates per subagent. A newer update from the same
subagent replaces its pending update; independent subagents keep separate entries.
Success, failure, abort and mid-run updates all follow this route. Silent/advisor
instructions remain in the update so the assistant can use findings internally.

Announcements use the shared voice floor check: user speech, an active response,
and queued audio playback delay delivery. A hidden, tool-capable voice turn
processes the update with current conversation context and produces speech through
the normal TTS pipeline. The original notification metadata and cron attribution
travel with the turn. No synthetic user bubble is echoed. The assistant can read
additional output or resolve a blocker without starting a competing text turn.

The assistant decides whether an update adds useful information. It speaks the
new outcome before optional visual-summary tools, or outputs the internal
`[TASK_UPDATE:SILENT]` marker for routine progress or findings already heard.
The marker is stripped from speech, captions, and persisted assistant text; a
completed silent decision acknowledges the update without audio.

Spoken results require forwarded reply audio and remain pending through the
estimated playback tail. Progress narration alone, empty speech synthesis, and
failed speech synthesis leave them pending. A barge-in preserves the interrupted outcome without
creating another worker. A failed launch or an
explicit stop defers retry until the next user turn or task update. Hang-up returns
undelivered updates to the ordinary conversation path after pending voice starts
and the voice turn's teardown settle, since its abort clears the parent queue.
The handoff bypasses voice routing so a replacement call cannot reclaim it during
teardown. All parent deliveries enqueue even when idle and trigger the existing
queue drain after turn finalization, so simultaneous outcomes share its processing
lock and retry behavior.

PCM is framed into at most 100ms chunks, with the first available samples emitted
immediately. Socket emission runs roughly 500ms ahead of estimated playback,
keeping prefetched synthesis from flooding the relay queue. Pacing waits stay
outside the shared outbound-frame queue and abort with the turn, so cancellation
and control frames are not delayed. Hands-free clients reconnect on retryable
relay closes, including legacy backpressure code 4013.

The pending queue is session-local; this does not add a durable notification ledger
or client playback acknowledgements. Task records and worker output retain their
existing persistence. Automatic announcements follow the current exchange rather
than merging task updates into an already-running response.
