# Voice input diagnostics

Hands-free voice records signal measurements in the ordinary support log export. This includes calls started from the macOS companion. These diagnostics do not change capture constraints, speech thresholds, interruption timing, or task cancellation. They add no PCM recordings, transcript text, microphone labels, or device identifiers.

## Collect a reproduction

Use the same microphone, output device, volume, and companion surface as the failing call. Note whether output is through headphones or speakers.

1. Start a companion voice call. Stay quiet for about 20 seconds to capture the room baseline.
2. Ask for an explanation long enough to produce sustained speech. Stay quiet while it answers; note the time of any unexpected cutoff.
3. Ask it to start a background investigation. Stay quiet during startup; note missing acknowledgements or cancelled starts.
4. Deliberately interrupt an answer with a short spoken question. This provides a real interruption to compare against the unexplained cutoffs.
5. End the call and export logs through the existing feedback log export.

Keep the initial reproduction on the original audio setup. A second call using headphones, or using the built-in microphone instead of a headset, can isolate a route-dependent problem after the first capture.

## Client records

`[live-voice-input]` entries are serialized JSON in `electron-main-logs.txt`. Electron collects them from every renderer, so export does not depend on which window hosts the companion call. The same events appear as `voice_input` in the web diagnostics lifecycle ring.

- `capture_started` and `input_switched` report applied echo cancellation, noise suppression, gain control, channel count, and track/context/output sample rates. `null` means the browser did not report a setting. An explicit device selection reports whether it matched, without logging either device identifier.
- `capture_mute`, `capture_unmute`, `capture_ended`, and `capture_statechange` expose track and audio-context transitions. Listeners retire with the old stream on a device switch or stop.
- `session_ready` links the client `captureId` to the server `sessionId`. Capture can open before the server is ready, so earlier entries have a null session ID. `entry` identifies the launch surface when supplied.
- `speech_started`, `turn_cancelled`, and `utterance_discarded` report whether playback was active, held, or actually resumed after an unusable utterance.

## Server records

Search the assistant log for `Live voice input diagnostics` or `voice_input_`. All records include session, input-turn, assistant-turn, and speech-generation identifiers where available, plus the effective threshold, room floor, echo configuration, playback estimate, and foreground-task state.

- `voice_input_window` summarizes each approximately five-second arrival window: received audio duration, zero-signal duration, duration-weighted mean amplitude, minimum/maximum chunk mean amplitude, classified speech/silence/echo duration, and maximum arrival gap. Window emission requires incoming audio; `voice_input_closed` flushes a partial window.
- The same window includes `sttSubmittedChunks`, `sttSubmittedAudioMs`, and `sttMaxSubmissionGapMs`. These measure handoff to the transcription adapter, not provider receipt. A probe can buffer audio before submission, and the final chunk of an arrival window can be submitted in the next window. Compare sustained windows to identify input that arrives normally but stops reaching transcription.
- `voice_input_provider_turn_start` and `voice_input_provider_turn_end` record provider boundaries alongside local VAD state. End records include confidence, the provider's `trigger` (`model`, `timeout`, or `manual`), decoded audio position in seconds from stream start, and elapsed time since locally detected speech. Missing provider fields are null. These records describe received decisions, including ones ignored as stale or after fallback; correlate with the turn metrics to identify the boundary that committed the request.
- `voice_input_microphone_gate_changed` records when the transcription audio gate closes or reopens. `microphoneGateClosed` is included with the other input diagnostics. Closing replaces room audio with silence; it does not commit a transcript or stop local energy detection.
- `voice_input_barge_in_armed`, `voice_input_barge_in_fired`, and `voice_input_barge_in_expired` distinguish a candidate from an accepted or expired local interruption on providers without native turn detection. Fired events include accumulated speech duration, guard resets, and a bounded trace of the preceding two seconds (at most 40 input chunks).
- `voice_input_speech_started` includes `source: "provider"` when a Flux `StartOfTurn` triggers the client speech signal and any active-turn cancellation. `source: "local"` identifies local onset or a confirmed pre-dial guard replay; guards completed during ordinary streaming use `voice_input_barge_in_fired`.
- Each trace entry captures the amplitude and gate/echo state before classification, and classified durations, remaining probe buffer, and correlation result after classification. The classifier can hold a probe and release multiple older chunks together, so a row's classified duration can differ from its received duration. A null correlation means no comparison ran, not a measured zero correlation.
- `voice_input_speech_routed` binds the speech generation to the input turn that actually receives its audio. At onset, the prior spent cycle may still be installed, so use this routing record for correlation rather than assuming the onset's `inputTurnId` is the new utterance.
- `voice_input_transcript` reports committed character count and provider, never words. `voice_input_utterance_discarded` reports the discard reason and remaining transcript/partial state.

Amplitude uses the classifier's PCM16 mean-absolute scale, not the client's normalized UI meter. Playback timing is the server's estimate, not proof that sound was heard. An empty transcript is evidence of no usable transcription; it does not establish that the person was silent or that the detector was wrong.

These are local diagnostic logs, not new analytics events or voice protocol fields. Existing log retention and export apply.

## Flux pause handling

When Flux owns turn detection, microphone audio passes through for one second of received audio after the last locally detected speech. After that, the input gate replaces room audio with digital silence while the microphone and local energy detector keep listening. The cutoff is measured in PCM samples, so network batching does not change it. Flux continues receiving elapsed silence and owns the turn boundary; closing this gate does not release the question.

While closed, the gate holds the most recent 200 ms before deciding whether to send those samples as silence or as the lead-in to resumed speech. On speech onset, it forwards that lead-in and the new speech exactly once. The provider feed can lag input by up to 200 ms while idle, then catches up on speech onset. Confirmed playback echo is replaced with silence before entering this buffer. Idle audio is not accumulated into request recordings. Manual capture and locally endpointed providers retain their existing routing.

Flux `StartOfTurn` owns hands-free interruption, independently of the provider end-of-turn setting. Above-threshold microphone audio alone cannot pause playback, cancel a reply, or trigger a speech-start screenshot. A provider turn start emits `speech_started` immediately, without the local sustained-speech delay, and cancels an active reply through the shared interruption path. Duplicate or older provider turn indices are ignored within a stream. Other providers retain the local guard. This waits for provider recognition and does not guarantee rejection of playback echo or background speech that Flux transcribes.

Managed Flux maps provider turn indices into one continuous sequence across transparent relay reconnects. A new relay connection restarting at zero therefore cannot make fresh speech look like a duplicate. If connection setup falls back to a provider without native turn detection, the suppressed local onset is replayed through the local interruption path, preserving its sustained-speech guard result even if the utterance ended during the dial.

The gate shares the existing adaptive energy classifier. Quiet speech within the one-second tail passes through; quiet onset in the 200 ms buffer is preserved if followed by detected speech. Sustained speech entirely below the local threshold can be suppressed, and noise classified as speech can reopen the gate. This limits background exposure rather than guaranteeing that every false transcript is eliminated.

For a focused reproduction, say an unfinished question such as "Did they help invent", pause briefly, then complete it with "ChatGPT". Repeat with a shorter and a longer pause, plus a complete short question. Note when the assistant starts answering and export the logs. Check that STT submissions continue during the pause, then use the provider end event's time, confidence, and trigger to distinguish model endpointing from a timeout. Tests verify audio delivery and event handling; they do not establish how Flux will segment real speech.

For the idle gate, stay silent and type for 20 seconds, then ask a question with a pause longer than one second. Repeat with a quiet voice and with a deliberate interruption during an answer. Check for phantom requests, a clipped first syllable, split questions, and missed interruptions. Correlate those observations with gate transitions and provider turn events.
