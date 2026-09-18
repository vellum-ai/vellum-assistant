# Background task outcomes in live voice

The conversation's active live-voice session owns delivery of subagent updates
while the call is open. `injectMessageIntoParent` offers updates carrying
`subagentNotification` metadata to the existing `LiveVoiceSessionManager` before
enqueuing a generic parent turn. The manager only routes to its session with the
matching conversation ID. A closing session holds incoming updates for its
teardown handoff. Other conversations and fully closed calls retain the ordinary
parent delivery path.

The session keeps one outcome queue for explicit subagents and completed
interrupted-turn continuations. A newer update from the same task replaces its
pending payload and preserves its delivery state; independent tasks keep separate
entries. Success, failure, abort and mid-run updates all follow this route.
Silent/advisor instructions remain in the update so the assistant can use findings
internally. Cancelling a running continuation does not discard finished outcomes.

A user turn may read pending findings as context without consuming them. Its
completed reply playback provides evidence for the next announcement decision,
so an answer that actually covered the findings can be skipped and an unrelated
answer leaves them due. Speculative dispatches and rollbacks do not own delivery.

Announcements use the shared voice floor check: user speech, an active response,
and queued audio playback delay delivery. A hidden, tool-capable voice turn
processes the update with current conversation context and produces speech through
the normal TTS pipeline. The original notification metadata and cron attribution
travel with the turn. No synthetic user bubble is echoed. The assistant can read
additional output or resolve a blocker without starting a competing text turn.

The assistant decides whether an update adds useful information. It speaks the
new outcome before optional visual-summary tools, or outputs the internal
`[TASK_UPDATE:SILENT]` marker for routine progress or findings already heard.
The marker is stripped from speech and captions; a completed silent decision
acknowledges the update without audio.

Spoken results require forwarded reply audio and remain pending through the
estimated playback tail. Progress narration alone, empty speech synthesis, and
failed speech synthesis leave them pending. Announcement prompts carry explicit
interruption state and the latest reply with completed playback for that task.
Generated conversation text and a displayed card are not playback receipts.
Interruption state survives a progress update being replaced by its final report.
A barge-in preserves the interrupted outcome without creating another worker.
A failed launch or an
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
and control frames are not delayed. Assistant audio recordings contain only
frames successfully sent to the transport. Hands-free clients reconnect on retryable
relay closes, including legacy backpressure code 4013.

The pending queue is session-local; this does not add a durable notification ledger
or client playback acknowledgements. Task records and worker output retain their
existing persistence. Completed-playback receipts mean that reply audio was sent
and its estimated playback tail elapsed without interruption; they do not prove
that the speaker was audible. The queue keeps the latest completed reply receipt
per task until the call closes. Automatic announcements follow the current
exchange; they do not modify an already-running response.

## macOS companion QA

Start a fresh conversation from the companion and use a new investigation topic
so an earlier report cannot satisfy the request. Ask explicitly for a background
agent. Use ordinary conversational pauses; timed silence is not required.
Continuous Flux input and the diagnostics described in
[voice input diagnostics](voice-input-diagnostics.md) apply to these calls.

1. **Ordinary completion.** Ask for a small background investigation and wait.
   Confirm the task actually starts, the assistant acknowledges the request, and
   useful findings are spoken without asking for them. A completion-only notice
   or visual summary without an audible explanation is not sufficient.
2. **Keep talking.** Start another investigation, then ask an unrelated question.
   Include a natural pause partway through the question. The question should stay
   together, the work should survive, and its results should wait for the current
   exchange to finish before being announced. Repeat with an interrupted request
   that continues in the background, not only an explicitly spawned agent.
3. **Interrupt the announcement.** Speak while findings are being announced.
   The assistant should yield, answer the interruption, and retain the unheard
   result for appropriate delivery. Interrupting an announcement should not spawn
   another copy of the investigation. Let the full report arrive after an
   interrupted progress announcement; the final report must retain that delivery
   state and briefly resume useful unheard findings.
4. **Two tasks.** Request two independent investigations. Keep chatting while
   they run, then leave an opening. Both useful outcomes should arrive without
   overlapping audio, repetitive status announcements, or a disconnect.
5. **Hang up before delivery.** End the call with work still running or a result
   waiting to be heard. Confirm the outcome reaches the conversation afterward.

Record approximate times for requests, interruptions, missing results, and any
disconnect. Export support logs after the call. Distinguish the request being
acknowledged, the worker starting, and the result being heard; they exercise
different parts of the flow.
