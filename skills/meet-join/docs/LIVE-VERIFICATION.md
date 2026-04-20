# Meet-join live verification runbook

Manual smoke tests that cover the end-to-end paths unit/integration tests
cannot exercise. These close the live-verification gaps called out in
Phase 1.12 of the meet-join plan: multi-party DOM scrapers, streaming STT,
barge-in, and consent-triggered auto-leave.

Every test below is runnable in isolation — you do not need to run them in
order. Each one lists exact log patterns to grep for, concrete pass/fail
criteria, and what to capture when something goes wrong.

## Preamble

### Prerequisites

- A running Vellum assistant on the machine under test (bare-metal or Docker).
- The `meet` feature flag enabled — default on. Check with
  `cat ~/.vellum/protected/feature-flags.json 2>/dev/null` and
  `rg '"meet"' meta/feature-flags/feature-flag-registry.json`.
- A configured STT provider under `services.stt.provider` (`deepgram`,
  `google-gemini`, or `openai-whisper`) with credentials in the credential
  store. For Test 2, `deepgram` is required — only Deepgram emits the
  speaker labels the SpeakerIdentityTracker expects.
- A Google Meet meeting URL you can admit a bot into. For Test 1 you will
  need two additional humans on separate accounts/devices; for Tests 2–4
  you can run solo.
- `jq` on `$PATH` for inspecting `transcript.jsonl`.

### Starting a test meeting and invoking `meet_join`

1. Create or open a Meet meeting: `https://meet.google.com/xxx-yyyy-zzz`.
2. Keep the meeting open on your host so you can admit the bot from the
   "Asking to join" lobby. The bot's display name is configurable via
   `services.meet.botDisplayName` — the default shows up as "Vellum".
3. From the assistant UI (or a conversation thread), ask:
   `"Join this Meet: https://meet.google.com/xxx-yyyy-zzz"`. The skill's
   `SKILL.md` requires an explicit request verb and a valid Meet URL.
4. The assistant will call the `meet_join` tool. Within ~20s you should see
   a `meet.joining` event in the conversation stream, then `meet.joined`
   once the bot's `isSelf` participant arrives on the DOM.

### Where the logs live

- **Daemon logs** (pino JSON, one object per line):
  `~/.vellum/workspace/logs/daemon-stderr.log`.
  See `assistant/src/util/platform.ts` — `getDaemonStderrLogPath()`.
  In Docker mode the workspace is mounted at `/workspace`, so the path
  inside the container is `/workspace/logs/daemon-stderr.log`.
  Tail with `tail -F ~/.vellum/workspace/logs/daemon-stderr.log`.
- **Bot container logs**: `docker logs vellum-meet-<meetingId>`. In
  Docker-in-Docker mode (assistant itself running in a container) the bot
  containers are nested — run `docker logs` from _inside_ the assistant
  container:
  `docker exec <assistant-container> docker logs vellum-meet-<id>`.
  The meeting id is a freshly generated UUID — `meet_join` calls
  `randomUUID()` (see `skills/meet-join/tools/meet-join-tool.ts`), and the
  session manager names the container `vellum-meet-${meetingId}` (see
  `skills/meet-join/daemon/session-manager.ts`). It is NOT derived from
  the Meet URL. `docker ps --format '{{.Names}}' | rg vellum-meet` to
  list.
- **Per-meeting artifacts**: `$VELLUM_WORKSPACE_DIR/meets/<meetingId>/`.
  See `skills/meet-join/daemon/storage-writer.ts`. Files:
  `audio.opus`, `segments.jsonl`, `transcript.jsonl`, `participants.json`,
  `meta.json`.

### Helpful grep cheatsheet

All log lines below are pino JSON — use `rg` with JSON-aware patterns.

```bash
# Meet session lifecycle
rg '"MeetAudioIngest: bot connected"' ~/.vellum/workspace/logs/daemon-stderr.log
rg '"Meet barge-in: cancelling in-flight TTS"' ~/.vellum/workspace/logs/daemon-stderr.log
rg '"MeetConsentMonitor: objection detected"' ~/.vellum/workspace/logs/daemon-stderr.log
```

---

## Test 1: Multi-party scraper accuracy

**Goal**: a 3-person meeting (the Vellum bot + 2 humans) produces correct
`participant.change` and `speaker.change` events as humans join, leave, and
take turns speaking.

### Setup

- Human A on machine 1, Human B on machine 2.
- Empty Meet room (`https://meet.google.com/xxx-yyyy-zzz`), admitted by
  Human A (the host).
- Terminal tailing `daemon-stderr.log` with the grep below primed.

### Steps

1. Ask the assistant to join. Admit the bot via Meet's lobby.
2. Wait ~5s for the bot to settle (you should see the bot tile render).
3. Human A unmutes, says "Hello from Alice", re-mutes.
4. Human B joins the meeting (Human A admits them from the lobby).
5. Human B unmutes, says "Hello from Bob", re-mutes.
6. Human A unmutes, says "Goodbye from Alice", re-mutes.
7. Human B leaves the meeting.
8. Ask the assistant to leave: "you can drop out now".

### Pass criteria

Every check below must hold. The daemon log lines are produced by the
event-hub publisher in `daemon/event-publisher.ts`, which translates
wire-level bot events into SSE `meet.*` events. The publisher does not
itself log on every dispatch, so the definitive signal comes from the
persisted artifacts.

- `participants.json` at teardown reflects the participants still present
  when the snapshot was last written — it is a running snapshot, and
  `storage-writer.ts` `writeParticipantsJson` removes entries on leave.
  Verify:
  ```bash
  jq 'length' ~/.vellum/workspace/meets/<id>/participants.json
  ```
  Expected: matches the number of non-bot humans still present when the
  bot left (step 7 leaves Alice only → `1`).
- `segments.jsonl` contains at least three closed spans, with
  `speakerName` values covering both Alice and Bob. The span before the
  first `speaker.change` is not persisted — the writer only closes a span
  on the _next_ change (see `closeOpenSegmentAt`), so the first
  `speaker.change` after join opens segment #1.
  ```bash
  jq -r '.speakerName' ~/.vellum/workspace/meets/<id>/segments.jsonl | sort -u
  ```
  Expected: two distinct human names (bot is silent, should never appear).
- SSE event stream, observed via the desktop app's meeting view or by
  subscribing to the daemon event hub: at least four
  `meet.participant_changed` events (bot-self join, Bob join, Bob leave,
  bot leave) and at least three `meet.speaker_changed` events (one per
  human utterance).
- `docker logs vellum-meet-<id>` shows the extension's in-page
  `participants.ts` feature emitting participant deltas — grep for
  `"participant.change"`.

### Fail signals

- Duplicate entries in `participants.json` with the same `id` — indicates
  the writer's id-keyed dedupe in `onParticipantChange` regressed.
- `speakerName: "Unknown speaker"` or empty string for a known human
  speaker — the extension's `speaker.ts` DOM scrape is returning a stale
  or missing name.
- Only the first speaker ever shows up in `segments.jsonl` — speaker
  change events are not being dispatched through
  `MeetSessionEventRouter`.

### Capture on failure

- `docker logs vellum-meet-<id> > /tmp/vellum-meet-<id>.log`.
- `cp -r ~/.vellum/workspace/meets/<id> /tmp/meet-artifact-<id>`.
- Screen recording of the Meet DOM showing the speaker tile transitions
  (helps correlate against log timestamps).
- `rg meet ~/.vellum/workspace/logs/daemon-stderr.log > /tmp/daemon-meet-<id>.log`.

---

## Test 2: STT end-to-end (transcript + speaker attribution)

**Goal**: a 1:1 meeting where the human speaks a scripted phrase produces
a final `transcript.chunk` that lands both in `transcript.jsonl` and in
the conversation UI, with the Deepgram-emitted speaker label correctly
mapped to the DOM participant.

### Requirements

- `services.stt.provider: "deepgram"` with valid credentials. (Other
  providers work for text-only verification but do not emit
  `speakerLabel`, so the speaker-attribution half of this test does not
  apply — note this under Known limitations if your environment forces
  a non-Deepgram provider.)

### Scripted phrase

Speak, clearly and unhurriedly:

> **"The quick brown fox jumps over the lazy dog."**

This phrase is unambiguous for every major STT provider and gives a
stable string to grep against.

### Steps

1. Start a new Meet meeting alone; note the meeting id.
2. Ask the assistant to join; admit the bot.
3. Wait for the daemon log line
   `"MeetAudioIngest: bot connected"` (see
   `daemon/audio-ingest.ts:371`). This confirms the STT streaming
   session is live and the bot's PCM socket is wired.
4. Unmute, speak the scripted phrase in a normal voice, re-mute.
5. Wait ~3s for Deepgram's final.
6. Ask the assistant to leave.

### Pass criteria

- **Transcript written**. In `transcript.jsonl`:
  ```bash
  jq -c 'select(.text | test("quick brown fox"; "i"))' \
    ~/.vellum/workspace/meets/<id>/transcript.jsonl
  ```
  Expected: at least one line with `text` containing the phrase. Each
  line also carries `timestamp`, optional `speakerId`, optional
  `speakerLabel`, optional `confidence` (see `storage-writer.ts`
  `onTranscriptChunk`). Interim chunks are discarded — only finals hit
  the file.
- **Conversation UI message**. The conversation thread opened by the
  `meet_join` tool should render the transcript chunk as a message
  with speaker attribution. This comes from
  `daemon/conversation-bridge.ts` subscribing to the same dispatcher as
  the storage writer.
- **Speaker label mapped**. When the provider is Deepgram, the
  `speakerLabel` field on the transcript line should be non-empty AND
  the `speakerId` field should match the human's DOM participant id
  (not `null`, not the bot's `isSelf` id). This is the
  SpeakerIdentityTracker's job — it cross-references Deepgram's opaque
  `speaker_id` against the DOM active-speaker stream and writes the
  bound `speakerId` through.
  ```bash
  jq 'select(.text | test("quick brown fox"; "i"))
      | {speakerLabel, speakerId}' \
    ~/.vellum/workspace/meets/<id>/transcript.jsonl
  ```
  Expected: both fields present and non-null.
- **Confidence reasonable**: `confidence > 0.8` for the scripted phrase
  (pangram is easy on any streaming ASR).

### Fail signals

- No lines in `transcript.jsonl` at all: the streaming session failed to
  start (check for `MeetAudioIngestError` in daemon log) or the bot is
  not forwarding PCM (check bot logs for the audio-capture warnings).
- `speakerLabel: null` on Deepgram: provider did not emit diarization —
  confirm the adapter requested `diarize: "preferred"` (see
  `daemon/audio-ingest.ts:574`).
- `speakerId` matches the bot's `isSelf` participant id: the
  SpeakerIdentityTracker mis-bound the ASR label to the silent bot.
  Capture `participants.json` alongside the transcript line.

### Capture on failure

- `cp ~/.vellum/workspace/meets/<id>/transcript.jsonl /tmp/`.
- `cp ~/.vellum/workspace/meets/<id>/participants.json /tmp/`.
- `cp ~/.vellum/workspace/meets/<id>/audio.opus /tmp/` (play it back to
  verify audio actually landed in ingest).
- `rg -i 'MeetAudioIngest|speaker-resolver|transcript' ~/.vellum/workspace/logs/daemon-stderr.log > /tmp/stt-<id>.log`.

---

## Test 3: Barge-in cancels in-flight TTS within 500ms

**Goal**: a >5s TTS utterance started with `meet_speak` is cancelled
within 500ms of a human starting to speak, the bot's audio stops cleanly,
and the bot's HTTP server receives `DELETE /play_audio/:streamId`.

### Steps

1. Start a solo Meet meeting; ask the assistant to join; admit.
2. Once joined, ask the assistant to say aloud:

   > "Please say this verbatim: 'I am now going to read a very long
   > sentence that will take at least six or seven seconds to finish
   > speaking so we have a large window of time to interrupt the
   > assistant mid-utterance for the barge-in test.'"

   That phrase is deliberately ~7s at normal synth rate.

3. ~2s into the assistant's speech, unmute and say "Stop" (or any
   short utterance) loudly enough that your mic's VAD picks it up.
4. Observe:
   - The bot's audio in the meeting cuts off.
   - Daemon log emits
     `"Meet barge-in: cancelling in-flight TTS"` with a `trigger`
     field of either `"speaker.change"` or `"transcript.chunk"` (see
     `daemon/barge-in-watcher.ts:375`).
   - Bot log emits a request line for `DELETE /play_audio/<streamId>`.
     The handler is in
     `skills/meet-join/bot/src/control/http-server.ts:461`.
     ```bash
     docker logs vellum-meet-<id> 2>&1 | rg 'DELETE /play_audio/'
     ```

### Pass criteria

- Wall-clock time between the start of your interjection and the bot's
  audio cutting off ≤ **500ms**. The watcher's debounce is 250ms
  (`BARGE_IN_DEBOUNCE_MS`), plus network + pacat flush; 500ms is the
  user-visible budget.
- Daemon log line `"Meet barge-in: cancelling in-flight TTS"` appears
  exactly once for this utterance (not multiple times — the watcher's
  `scheduleCancel` leaves a pending timer in place rather than re-arming
  on every trigger).
- Bot log shows `DELETE /play_audio/<streamId>` returning `200`
  (`{ cancelled: true, streamId }`), not `404` (which would mean the
  POST handler had already completed before the DELETE landed — a
  benign race, but it means the barge-in path did not do the work).
- `assistantEventHub` emits `meet.speaking_ended` for the cancelled
  stream id. The bridge between the HTTP handler's `cancelled: true`
  response and this event goes through `MeetTtsBridge` / the session
  manager — observe via the meeting SSE stream.
- No trailing audio: the meeting audio should not produce any bot
  speech after your interjection ends. (50ms of silence is flushed by
  design via `TRAILING_SILENCE_MS`.)

### Fail signals

- Bot audio continues past 500ms: barge-in watcher did not schedule a
  cancel, OR the debounce window elapsed with no trigger matching.
  Check `_isBotSpeaking()` accounting — the
  `meet.speaking_started` / `meet.speaking_ended` bookkeeping must
  run through `assistantEventHub` subscription.
- Multiple duplicate `"cancelling in-flight TTS"` lines: the
  "don't re-arm pending cancel" guard in `scheduleCancel` regressed.
- Bot log shows `404` on the DELETE: the daemon cancelled via the
  wrong streamId (or the POST finished first — record timestamps).
- Daemon log shows the cancel line but meeting audio kept playing:
  the `DELETE /play_audio/:streamId` call threw or never left the
  daemon (check `MeetTtsBridge.cancel()` logs near
  `"cancel(): DELETE /play_audio failed"`).

### Capture on failure

- Screen/audio recording of the bot's voice trailing off (phone camera
  aimed at speakers is fine — we just need the timing).
- `docker logs vellum-meet-<id> 2>&1 > /tmp/vellum-meet-bargein-<id>.log`.
- `rg -i 'barge-in|tts|speaking_started|speaking_ended|play_audio' ~/.vellum/workspace/logs/daemon-stderr.log > /tmp/daemon-bargein-<id>.log`.

---

## Test 4: Auto-leave on participant objection

**Goal**: a meeting in which any participant objects to the AI note-taker
causes the bot to post a goodbye chat message within 3s and the container
to exit within 5s. Verify both the chat-path and transcript-path
triggers.

### Requirements

- `services.meet.autoLeaveOnObjection: true` (the default — see
  `config-schema.ts`). If you have overridden it to `false` locally, the
  monitor will log the decision without leaving; test that separately.

### Test 4a — chat-triggered leave

Exact phrase to paste into Meet chat:

> **"Please leave, bot."**

This contains `"please leave"`, the canonical entry in
`DEFAULT_MEET_OBJECTION_KEYWORDS` (`config-schema.ts:12`). The keyword
hit triggers the LLM confirmation pass with the rolling buffer; the
LLM should return `{ "objected": true, ... }`.

### Steps (4a)

1. Start a solo meeting; ask the assistant to join; admit.
2. Once the bot is joined, open Meet's chat panel and send the phrase
   above.
3. Start a wall-clock stopwatch when you press Send.
4. Watch for:
   - Within 3s: a bot chat message appears (configurable goodbye — by
     default "Thanks, I'm stepping out now" or similar).
   - Within 5s: `docker ps` no longer lists `vellum-meet-<id>` (container
     exited).
5. Daemon log checks:
   ```bash
   rg '"MeetConsentMonitor: objection detected"' \
     ~/.vellum/workspace/logs/daemon-stderr.log
   ```
   Exactly one line with fields:
   `meetingId`, `trigger: "keyword:chat"`, `reason: "<non-empty>"`,
   `autoLeave: true` (see `daemon/consent-monitor.ts:597`).

### Test 4b — transcript-triggered leave

Exact phrase to speak aloud, clearly:

> **"Please leave, bot."**

### Steps (4b)

1. New meeting, same setup.
2. After the bot joins and the STT session is up
   (`"MeetAudioIngest: bot connected"` visible), speak the phrase.
3. The transcript path requires a _final_ chunk (interims are skipped —
   see `consent-monitor.ts:351`). Expect the leave to start within
   ~3–5s of finishing the phrase (Deepgram final latency +
   `LLM_CHECK_DEBOUNCE_MS` up to 8s in the worst case).
4. Daemon log: same `"MeetConsentMonitor: objection detected"` line,
   this time with `trigger: "keyword:transcript"`.

### Pass criteria (both 4a and 4b)

- Bot posts a goodbye chat message before disappearing from the
  meeting — captured in the Meet chat panel and in
  `docker logs vellum-meet-<id>` as a `POST /send_chat` request from
  the daemon.
- `docker ps | rg vellum-meet-<id>` returns empty within 5s of the
  objection landing.
- `meta.json` in the meeting's artifact dir has `endedAt` populated.
- `meet.left` SSE event fired with `reason` starting with
  `"objection: "` (matches the session manager's leave-reason
  synthesis in `consent-monitor.ts:611`).

### Fail signals

- `"objection detected"` line but no goodbye chat: the leave path
  started but the goodbye send failed. Check
  `"MeetConsentMonitor: session leave failed"` near
  `consent-monitor.ts:614`.
- No `"objection detected"` line within 30s of the trigger: either the
  keyword wasn't matched (`config.objectionKeywords` was overridden and
  no longer contains `"please leave"`) or the LLM returned
  `objected: false`. Look for
  `"MeetConsentMonitor: LLM confirmed no objection"` as the negative
  signal; look for `"LLM call failed"` as the timeout/error signal.
- Container still running after 10s: the `leave()` path short-circuited
  or hung before calling `docker stop`. Check for
  `"Bot /leave failed or timed out — falling back to container stop"`
  — that fallback should still kill the container, so a stuck
  container indicates the fallback itself regressed.

### Capture on failure

- Full daemon log slice for the meeting:
  `rg -i 'consent|objection|leave' ~/.vellum/workspace/logs/daemon-stderr.log > /tmp/consent-<id>.log`.
- `docker logs vellum-meet-<id> 2>&1 > /tmp/vellum-meet-consent-<id>.log`.
- `cp -r ~/.vellum/workspace/meets/<id> /tmp/meet-consent-<id>`.
- Screen recording of the Meet chat panel timing the Send → bot-goodbye
  → container-exit sequence.

---

## Known limitations

Record issues observed during live runs here. Each entry should include:
date, what broke, the captured artifacts, and whether a GitHub/Linear
issue exists.

<!-- Template:
### YYYY-MM-DD — short title
- **Symptom**: what the tester saw.
- **Captured**: paths to logs/artifacts under `/tmp` or an uploaded
  location.
- **Tracked in**: GH issue / Linear ticket id, or "not yet filed".
- **Workaround** (if any):
-->

(none yet — add entries as live runs surface issues)
