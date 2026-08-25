# Deepgram Flux Turn Detection: Local Spike Runbook

How to enable Deepgram Flux end-of-turn in live voice on your own machine, run it against the existing front-door path, and read a latency comparison that is actually honest.

Flux is a spike. `liveVoice.flux.turnEnd.enabled` defaults to `false`, the existing local-VAD-plus-front-door hold machinery is untouched and still the default, and it is still the fallback when Flux goes quiet. Nothing here is a rollout.

---

## Read this before you read any number

**`endpointCommitLatencyMs` is the headline, and it is the only endpoint field that is like-for-like across the two arms.** It measures the local VAD speech-stop mark to the moment the turn committed. Take its median per arm and compare the two medians. There is no arithmetic to do and no source-specific semantics to remember.

It is stamped in `releaseUtterance` (`live-voice-session.ts`), which every committed turn passes through whichever decider released it, from the same speech-stop anchor on both. So the two arms are one population measured over one span. It is absent only on a turn that never committed, and in push-to-talk, which this spike does not run.

It is also the only endpoint number that a Flux socket teardown stays out of: `releaseUtterance` stamps it before any stop. On a turn Flux itself closed there is no teardown to carry; on a caller-side release `roundTripMs`, `llmFirstDeltaMs`, and `totalMs` still carry one, and so does what the caller hears. Read "The socket teardown, and when it is load-bearing" in section 3 before you compare any of those three against a `deepgram` run.

### Why the other endpoint fields are not the comparison

`endpointDecisionMaxLatencyMs`, `endpointHoldCount`, and `endpointDecisionSource` all still exist and are all still worth reading. But `endpointDecisionMaxLatencyMs` is **not** comparable between arms, in two independent ways, and comparing it flatters Flux by roughly a full second with nothing in the output to tell you.

**It spans different things.**

| Path                                   | What `endpointDecisionMaxLatencyMs` actually spans                                                                                                                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpointDecisionSource: "provider"`   | Local VAD speech-stop mark to the `turn-end` event. This is the **whole** end-of-turn latency.                                                                                                                                         |
| `endpointDecisionSource: "front-door"` | Speculative dispatch to the hold verdict, i.e. the endpoint-decider LLM roundtrip **only**. The trailing-silence wait that had to elapse before that dispatch is not in the number, and neither is the hold extension that follows it. |

Source: `handleProviderTurnEnd` passes `this.msSinceLocalSpeechStop()` (`live-voice-session.ts`), while `holdSpeculativeTurn` passes `Date.now() - turn.speculativeDispatchedAtMs`, and the dispatch happens at the silence boundary.

**It samples different populations.** `markEndpointDecision` is called from exactly two places: the Flux commit, and the hold verdict. A front-door turn that committed straight through the boundary emits **no** `endpoint_decision` at all, and its metrics frame carries none of the three endpoint fields. So the front-door sample is "turns the model judged mid-thought", the slow tail by construction, while the Flux sample is every turn. Two denominators that cannot be reconciled after the fact is exactly why `endpointCommitLatencyMs` exists.

Read `endpointDecisionMaxLatencyMs` as a **breakdown of** the headline, not against the other arm: on a Flux turn it isolates how much of the commit latency was Flux's own decision, and on a held front-door turn it isolates the decider LLM roundtrip.

### What the front door actually costs

You do not need this to read the headline. You need it when a front-door number surprises you.

- On an **unheld** turn the added end-of-turn cost is `silenceThresholdMs` alone. The speculative leg dispatched at the boundary _is_ the assistant turn, so if the model does not return the hold token, generation has been running since the boundary and the decider roundtrip is not added latency. That is the common case, and the real bar Flux has to beat.
- On a **held** turn, add `endpointExtensionMs` (default **1500**) per hold, capped at `endpointMaxExtensions` (default **2**), so up to 3000ms on top.
- `silenceThresholdMs` is the trailing-silence wait the boundary cost. Its value is, in precedence order: the client's explicit "pause before reply" setting sent on the start frame, else `liveVoice.vad.silenceThresholdMs` (schema default **1200**, `config/schemas/live-voice.ts`), else the in-code `DEFAULT_SILENCE_THRESHOLD_MS` of **800** (`live-voice-session.ts`). In a real daemon run the factory always seeds the config value, so **1200 is the number in force** unless you moved the web client's pause slider or overrode the config key. The 800 constant governs only a session built with no `liveVoice` config at all, which in practice means tests.

### The cross-check that needs no correction

The per-turn timestamps in the metrics snapshot are absolute and come from one clock, and both paths stamp `utteranceEndAtMs` at the moment the turn commits (`markUtteranceReleased` runs inside `releaseUtterance`, which both paths call). `speechStartAtMs` is stamped at local VAD onset and is first-wins, so it survives a pause the front door held across.

```
utteranceEndAtMs - speechStartAtMs
```

Say the **same scripted sentence** on both arms, and the difference between the arms in that figure is the endpointing cost. It is an independent path to the same answer as `endpointCommitLatencyMs`: that field anchors at the speech-stop mark and this one at the VAD speech onset, so a run where the two disagree means the mic was picking up something the script did not say. Use it to sanity-check the headline.

---

## 1. Credentials

Flux shares the existing Deepgram credential. `credentialProvider: "deepgram"` in `providers/speech-to-text/provider-catalog.ts`, so there is **no new key to obtain and nowhere new to put it**. If `deepgram` already transcribes for you, Flux already has what it needs.

If it does not, set the Deepgram key the ordinary way (client Settings, Speech-to-text card) and pick either Deepgram entry; both write the same `deepgram` credential.

## 2. Enable Flux

> **Putting a provider on the `flux` model family turns off batch transcription for the whole workspace, not just live voice.** `services.stt.provider` plus `services.stt.providers.<provider>.model` is the single source of truth for every STT route, and Flux is the only family in the catalog with no `daemon-batch` boundary. For as long as it is set, these all stop working: voice-message and inbound-attachment transcription, the `transcribe` skill, the `media-processing` skill's audio segments, `POST /v1/stt/transcribe`, and phone-call transcription. Each reports a message naming Flux as the cause rather than failing silently, but they do not fall back to `deepgram` on their own. **Set `services.stt.providers.deepgram.model` back to `nova-3` when the spike is over**, and do not run the spike on an assistant that is also taking calls or handling voice messages.

Two keys in `config.json`, which lives at `$VELLUM_WORKSPACE_DIR/config.json` (default `~/.vellum/workspace/config.json`):

```json
{
  "services": {
    "stt": {
      "provider": "deepgram",
      "providers": { "deepgram": { "model": "flux" } }
    }
  },
  "liveVoice": {
    "flux": {
      "turnEnd": {
        "enabled": true
      }
    }
  }
}
```

Restart the daemon so the config is reloaded, then start a live-voice session **hands-free**. Push-to-talk is deliberately excluded: the latch requires a server-VAD turn detector, because in PTT the client's release already is the boundary and there is nothing for Flux to decide.

The rest of `liveVoice.flux` is optional and defaulted (`config/schemas/live-voice.ts`):

| Key                 | Default           | Range        | Notes                                                                                                                                   |
| ------------------- | ----------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `model`             | `flux-general-en` | any string   | English only in this spike.                                                                                                             |
| `eotThreshold`      | `0.7`             | 0.5 to 0.9   | Lower commits sooner and cuts speakers off more; higher adds latency.                                                                   |
| `eagerEotThreshold` | _unset_           | 0.3 to 0.9   | Leave it unset. See "Known gaps".                                                                                                       |
| `eotTimeoutMs`      | `5000`            | 500 to 60000 | Silence after which Flux force-ends a turn it never got confident about. Lower it to 1500 to 2000 for a measurement run; see section 4. |

## 3. Run the A/B

**Flip `turnEnd.enabled` between runs and leave the `flux` model family selected in both arms.** That holds the STT engine, the model, the socket, and the transcriber lifecycle constant, so the only thing that changes is which signal commits the turn.

- **Arm A (control):** `providers.deepgram.model: "flux"`, `turnEnd.enabled: false`. Flux transcribes; the four turn-detection events are ignored; the local silence boundary and the front-door hold path run exactly as they do today.
- **Arm B (treatment):** `providers.deepgram.model: "flux"`, `turnEnd.enabled: true`.

**Do not A/B by switching the model family between `nova-3` and `flux`.** That confounds two changes at once:

1. It swaps the STT model. `deepgram` runs `nova-2` (`DEFAULT_MODEL`, `deepgram-realtime.ts`), so any transcript-quality or first-partial difference lands in your latency numbers.
2. It swaps the transcriber lifecycle. `deepgram` implements `finalizeUtterance`, so the session adopts it as a persistent stream shared across the whole session (`sharedTranscriber`) and never tears it down between turns. Flux implements no `finalizeUtterance`, so every utterance owns its own `/v2/listen` socket and every release closes it. That per-turn socket churn is inside `roundTripMs` and `totalMs` on the Flux side and absent on the `deepgram` side, so a naive provider-swap A/B attributes it to turn detection. The next section is what it costs and why it cannot be removed.

Say the same scripted set of utterances in both arms. Include at least a few deliberate mid-sentence thinking pauses, because that is the case the hold path exists for and the case Flux has to not regress.

### The socket teardown, and when it is load-bearing

The Flux adapter implements no `finalizeUtterance`. That is forced by Flux's wire protocol, not a statement that Flux owns the turn boundary, and adding the method as a no-op would break transcript correctness.

`parseFluxFrame` emits `final` only on `EndOfTurn`, and that is the adapter's sole source of `final`. Flux offers no mid-stream flush, so `CloseStream` is the only message that makes it answer for a turn still in progress, which is exactly what `stop()` sends. A no-op `finalizeUtterance` would report `finalized` without flushing anything, so a turn released on a caller-side boundary would dispatch on an empty transcript while its real text arrived afterwards and was dropped as a late final segment. With `turnEnd.enabled` at its default `false` that is every turn, because the release always comes from the local silence path. With the latch on it is still every fail-open fallback, every max-duration force-end, and every barge-in, all of which release with a Flux turn open.

That reasoning holds for a turn the **caller** releases, and only for those. A turn Flux itself closes needs no flush at all: `EndOfTurn` emits the `final` immediately before `turn-end`, so the transcript is already complete when the release runs, and the stream can stay open (JARVIS-1538). The session reflects that split:

- **Provider-closed turns seal in place.** `handleProviderTurnEnd` marks the cycle `providerClosedTurn`, and the release moves it straight to `transcriber_closed` without stopping the transcriber. The stream serves the whole session, and `rearmAfterTurn` re-arms onto it synchronously.
- **Caller-side releases still close it.** The fail-open deadline, a max-duration force-end, and barge-in all release with a Flux turn potentially still open, and `CloseStream` remains the only message that makes Flux answer for one. Those releases retire the shared stream and tear it down; the next arm dials a fresh one.

Consequences for the numbers, all now specific to the caller-side path:

- **`endpointCommitLatencyMs` never contains a teardown.** `releaseUtterance` stamps the commit latency and `utteranceEndAtMs` before any stop, so the headline comparison is clean on both arms.
- **`roundTripMs`, `llmFirstDeltaMs`, and `totalMs` contain it only when the caller released the turn,** which with the latch on means the exceptional paths rather than every turn.

Before JARVIS-1538 every utterance dialed its own socket, and the audio arriving during that handshake was lost rather than replayed from the VAD pre-roll buffer. The opening words of each turn after the first went missing ("How many days are in February?" transcribed as "many days are in February?"). A persistent stream removes the handshake, and with it the gap.

### What this A/B still does not hold constant

With Flux as the provider in both arms, the transcript **final** arrives at different moments. In arm B the `EndOfTurn` frame emits `final` immediately before `turn-end`, so the final is already in hand at commit. In arm A the local boundary fires first and release calls `stop()`, which sends `CloseStream` and waits for Flux to flush. So `sttMs` (the `utteranceEnd` to `finalTranscript` span) is not comparable between arms. It is not the headline number, but do not read a regression into it.

## 4. Read the numbers

The daemon sends a `metrics` frame over the live-voice WebSocket on `turn_completed`, `turn_cancelled`, and `session_ended`. The endpoint fields are flattened onto that frame by `getLiveVoiceMetricsAggregateFields`:

| Field                          | Meaning                                                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `endpointCommitLatencyMs`      | **The headline.** Local VAD speech-stop mark to the commit. Present on every committed turn on both arms. Compare medians across arms. |
| `endpointDecisionSource`       | `"provider"` or `"front-door"`. Present only when an endpoint decision was recorded.                                                   |
| `endpointDecisionMaxLatencyMs` | Worst single decision latency in the turn. A breakdown of the headline, never a cross-arm comparison. See the first section.           |
| `endpointHoldCount`            | Hold verdicts in the turn. Always 0 on a Flux-committed turn.                                                                          |

The last three are **absent** unless a decision was recorded, which is deliberate: the absence is itself the signal, and it is what makes them useless as a cross-arm comparison. `endpointCommitLatencyMs` is absent only on a turn that never committed.

**How to see them.** The web client stores the whole frame but its `console.debug("[live-voice] turn latency", ...)` line does not print the endpoint fields. Read them from the raw frame instead: DevTools, Network, WS, select the live-voice socket, filter frames for `"type":"metrics"`, and read the `turn_completed` frames. The per-turn `metrics.recentTurns[]` array in the same frame carries the `timestamps` you need for the cross-check in the first section.

### Reading an arm-B turn

| What you see                           | What happened                                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpointDecisionSource: "provider"`   | Flux committed the turn. This is the measurement you came for.                                                                                |
| No endpoint fields at all              | The fail-open deadline fired, the utterance fell back to the silence path, and the front door released it without holding. Not a Flux sample. |
| `endpointDecisionSource: "front-door"` | Same fallback, but the front door then held. Not a Flux sample either.                                                                        |

Fallbacks are logged at `warn`, so they are visible at the default log level:

```
No provider end-of-turn is coming; falling back to the silence boundary for this utterance
```

The deadline is `liveVoice.flux.eotTimeoutMs` plus a 1000ms margin (`PROVIDER_TURN_END_FALLBACK_MARGIN_MS`), measured from the local speech-stop mark. If you see these routinely, you are measuring the fallback path, not Flux.

#### Lower `eotTimeoutMs` for the run

With the shipped defaults the fail-open budget is `eotTimeoutMs` (**5000**) plus `PROVIDER_TURN_END_FALLBACK_MARGIN_MS` (**1000**), so **6000ms from the local speech-stop mark**. The local silence boundary fires at ~1200ms and then hands the turn to Flux, so a stalled turn is roughly **4.8 seconds of dead air** before the utterance replays onto the hold path and anyone answers.

That is the worst case by design (the budget has to clear Flux's own force-end), but it is a bad property to carry through a measurement run. It makes a stall expensive to sit through, which biases you toward not reproducing one, and it means arm B's slow turns are dominated by a timeout rather than by turn detection.

Set `liveVoice.flux.eotTimeoutMs` to **1500 to 2000** for the duration of the run. The budget drops to 2500 to 3000ms, a stall costs about 1.3 to 1.8 seconds past the silence boundary instead of 4.8, and arm B stays representative of what Flux does rather than of what the deadline does. Put it back before drawing any conclusion about the shipped configuration: it also changes how long Flux itself waits before force-ending a turn it never got confident about.

### Prefer medians, and do not chase a single bad sample

`isStaleProviderTurnEnd` decides on Flux's own `turn_index`, which `parseFluxFrame` carries onto `turn-start` and `turn-end`. The cycle records the newest turn Flux opened, so a delayed end-of-turn for an older index is recognized as stale and dropped, even though the caller has resumed speaking since. An end-of-turn for the turn still in progress is never stale: the mid-thought pause is what Flux's turn model exists to judge, its verdict covers the resumed speech, and the newest speech-stop mark is the right anchor for it.

The local VAD generation counter is only the fallback, for an event that carries no turn number. There the outlier mode survives: if the caller resumes and stops again before a delayed `turn-end` lands, the second boundary re-stamps `turnBoundaryGeneration` to the current generation, the event stops looking stale, and it is accepted against the newer speech-stop mark. The **commit is still correct**, but the recorded latency is understated for that turn, in `endpointCommitLatencyMs` and `endpointDecisionMaxLatencyMs` alike, since they share the anchor.

Drops log at `info` and so are visible at the default log level, carrying `turnIndex`, `openTurnIndex`, `boundaryGeneration`, and `speechGeneration`:

```
Dropping a stale provider end-of-turn: the caller resumed speaking past the boundary it closed
```

A drop is not itself an error: the cycle stays open and still commits, on the end-of-turn for the resumed speech or on the fail-open deadline. Read the line's fields. A drop with both `turnIndex` and `openTurnIndex` present is the turn-index path working, and it also drops the silent variant of the same race. A drop with `turnIndex` absent means Deepgram is sending unnumbered events and the run is on the generation fallback, where individual samples can be skewed and legitimate fast end-of-turns are dropped conservatively. Either way, report medians over a run of turns and ignore individual extremes.

## 5. Confirm the session is really running Flux

The dialed URL is logged at `info` on every session open, and it carries the clamped query parameters. The API key travels in an `Authorization` header, never in the URL, so the log line is safe to read and paste.

```
grep "Opening Deepgram Flux session" ~/.vellum/workspace/data/logs/assistant-*.log
```

Check the URL is `/v2/listen` and contains `model=flux-general-en`, `eot_threshold`, `eot_timeout_ms`, and **no** `eager_eot_threshold`. That is the cheapest confirmation that the tuning you wrote is the tuning in force.

Deepgram's authoritative thresholds would come back on a `ConfigureSuccess` frame, but the adapter never sends `Configure` and the parser has no case for the response, so nothing echoes the tuning back. The dialed URL is the confirmation you have.

### Log levels

Every diagnostic this runbook tells you to read is at `info` or `warn`, and the pino level is `info` (`src/util/logger.ts`), so nothing here needs a source edit or a rebuild. That includes the stale-turn-end drop in section 4 and the chunk-cadence line in section 6.

One Flux line does sit at `debug`: `buildFluxQueryParams` reports clamping `eager_eot_threshold` down to the effective `eot_threshold`. It fires only if you set `eagerEotThreshold`, which this spike says to leave unset.

## 6. Chunk cadence

Deepgram recommends 80ms audio chunks for Flux. Capture cadence is a client concern and this spike does not change it, but the adapter makes it measurable from the daemon side: once per session, on the first audio frame, it logs at `info`

```
Deepgram Flux audio chunk cadence
```

with `byteLength`, `sampleRate`, `encoding`, `observedChunkMs`, and `recommendedChunkMs: 80`. `observedChunkMs` is derived from byte length and the negotiated sample rate and is only present for `linear16`, which is the default encoding. Read it before anyone proposes tuning the client; if it is already near 80 there is nothing to win there.

## 7. Known gaps

Do not rediscover these.

- **English only.** The spike pins `flux-general-en`. No language is forwarded to the adapter, because `language_hint` means nothing to a monolingual model. The catalog entry carries `languageSelection: "auto"`, so the Settings speech-to-text card renders no language picker for Flux. Read that as "no picker", not as detection: audio in another language transcribes as English rather than being detected.
- **No telephony, and no fallback either.** The catalog entry sets `telephonyMode: "none"`, so `resolveTelephonySttCapability` reports Flux as unsupported and the call session reports that as its error. Nothing reroutes the call to the `deepgram` provider: with Flux configured, calls on this assistant are not transcribed at all.
- **No batch, workspace-wide.** `supportedBoundaries` is `daemon-streaming` only, and `resolveBatchTranscriber` throws for it rather than returning the `null` that every batch caller reports as "no speech-to-text provider is configured". Callers surface the thrown message instead: `Deepgram Flux is streaming-only. Batch transcription requires the deepgram provider: set services.stt.provider to "deepgram".` See the warning in section 2 for the full list of surfaces this takes down.
- **No managed / velay path.** This is BYOK through the daemon only. The relay pins the model server-side, so managed rollout is a relay change.
- **Eager end-of-turn is off, and its being off is load-bearing.** `eagerEotThreshold` is optional with no default, and leaving it unset is precisely what stops Deepgram emitting `EagerEndOfTurn` / `TurnResumed` at all. The parser handles both frames and the session no-ops them, so the follow-up is small, but Deepgram warns that enabling speculation raises LLM calls by 50 to 70 percent. Note also that `buildFluxQueryParams` clamps `eager_eot_threshold` **down** to the effective `eot_threshold`, because Deepgram rejects the inverse combination.
- **The hold machinery is present and unchanged.** `HOLD_VERDICT_TOKEN`, the `includeHold` branch, the speculative dispatch and rollback state, `endpointExtensionMs`, and `endpointMaxExtensions` are all still there. The latch only skips them.
- **Local VAD still owns barge-in in both modes,** and must. A local energy gate on audio already in hand beats a provider roundtrip for an interrupt during playback, and the echo-adaptive part of the guard has to stay upstream of Flux, which hears only the microphone and cannot tell our own TTS bleeding through imperfect echo cancellation from a real caller turn.
- **Self-hosted bundles and `KeepAlive`.** The adapter sends a `KeepAlive` control frame every 5s, which cloud `/v2/listen` accepts and which is the only thing that resets Deepgram's server-side inactivity timer during silence. Self-hosted SageMaker Flux bundles reject it as a fatal `UNPARSABLE_CLIENT_MESSAGE`. The escape hatch is the adapter's `keepaliveIntervalMs: 0` option, but it is a constructor option only: `resolve.ts` passes just `sampleRate`, so pointing the adapter at a self-hosted bundle means editing that call site. There is no config key for it.

### Two invariants the measurement rests on

Check these if you port the spike anywhere else, because a run that violates either produces numbers that look plausible and are not.

- **The latch is up before the session's first boundary.** `start()` sends `ready` without waiting on the transcriber resolve, so the caller can speak and close a whole silence boundary while the handshake is in flight. `beginUtterance` seeds the latch from the **configured** provider before the dial and reconciles it against the resolved provider afterwards, so the opening turn is a Flux turn like every other one rather than a front-door turn inside a session that looks like a Flux session.
- **Every recorded latency is anchored at a real speech-stop.** `localSpeechStopAtMs` is stamped on every above-gate chunk in every server-VAD session, and `markEndpointCommit` records nothing at all when there is no mark, which is push-to-talk. `msSinceLocalSpeechStop()` therefore never reports a turn measured from zero, and both arms share the anchor.

## 8. Falling back

Set `liveVoice.flux.turnEnd.enabled` back to `false` (or delete the key) and restart. That is the whole rollback: the latch goes down, the turn-detection events become no-ops, and the silence-boundary path runs unchanged. You can leave the `flux` family selected or move back to `nova-3`; either is a working configuration.

Runtime fallback needs no action. A Flux stream that never emits `turn-end` is caught by the fail-open deadline and the utterance replays onto the silence path, so an outage degrades to today's behavior rather than to a hung turn.

## 9. What would justify deleting the hold path

The follow-up cleanup is not small: `HOLD_VERDICT_TOKEN`, the `includeHold` branch of `frontDoorDecisionRule`, the `holdEnabled` parameter on `classifyFrontDoorLeading`, six pieces of speculative-dispatch state in the session, and the `endpointExtensionMs` / `endpointMaxExtensions` config surface. It is worth doing only if Flux clears a real bar. Deepgram claims Flux decides in under 400ms; that claim is the hypothesis under test here, not an input.

Suggested bar, all measured on `endpointCommitLatencyMs` over enough turns for a median to mean something. That field deliberately excludes the per-turn socket teardown, which keeps the arms comparable but also means a bar cleared here is not by itself a case for running Flux in front of users: the teardown is a cost Flux keeps paying and `deepgram` does not.

1. **Median `endpointCommitLatencyMs` in arm B beats the median in arm A.** Most arm-A turns are unheld, so that median sits near `silenceThresholdMs`, about 1200ms with the defaults. Do not set the bar against arm A's held turns: beating those is easy and proves nothing, because most turns are not held.
2. **No regression on thinking pauses.** The hold path exists so a mid-sentence pause does not trigger a premature reply. Count premature commits on the scripted pause utterances in both arms. Flux has to be at least as good, not merely faster. A fast path that interrupts people is worse than the slow one.
3. **The fallback is rare.** If `warn`-level fallback lines appear on a meaningful fraction of turns, the hold path is not dead code, it is the live path, and deleting it removes the thing keeping the feature usable.
4. **Escalate and the spoken ack / progress phrasing still behave.** Flux bypasses only the `[0]` hold branch. Confirm `[1]` escalate still fires and acks still land before concluding the front door has nothing left to do.

If 1 and 2 both hold and 3 is clean, the cleanup is justified. If 1 holds but 2 does not, the answer is to tune `eotThreshold` upward and re-measure, not to delete anything.
