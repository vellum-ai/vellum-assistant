# Deepgram Flux Turn Detection: Local Spike Runbook

How to enable Deepgram Flux end-of-turn in live voice on your own machine, run it against the existing front-door path, and read a latency comparison that is actually honest.

Flux is a spike. `liveVoice.flux.turnEnd.enabled` defaults to `false`, the existing local-VAD-plus-front-door hold machinery is untouched and still the default, and it is still the fallback when Flux goes quiet. Nothing here is a rollout.

---

## Read this before you read any number

**The two paths do not measure the same span.** If you compare `endpointDecisionMaxLatencyMs` between a Flux run and a front-door run without correcting for it, you will get a number that flatters Flux by roughly a full second, and nothing in the output will tell you.

| Path                                   | What `endpointDecisionMaxLatencyMs` actually spans                                                                                                                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpointDecisionSource: "flux"`       | Local VAD speech-stop mark to the `turn-end` event. This is the **whole** end-of-turn latency.                                                                                                                                         |
| `endpointDecisionSource: "front-door"` | Speculative dispatch to the hold verdict, i.e. the endpoint-decider LLM roundtrip **only**. The trailing-silence wait that had to elapse before that dispatch is not in the number, and neither is the hold extension that follows it. |

Source: `handleFluxTurnEnd` passes `this.msSinceLocalSpeechStop()` (`live-voice-session.ts`), while `holdSpeculativeTurn` passes `Date.now() - turn.speculativeDispatchedAtMs`, and the dispatch happens at the silence boundary.

### The correction to apply

Do this arithmetic on every front-door number before you put it next to a Flux number:

```
front_door_end_of_turn_ms  >=  silenceThresholdMs
                             + (endpointHoldCount * endpointExtensionMs)
                             + endpointDecisionMaxLatencyMs
```

- `silenceThresholdMs` is the trailing-silence wait the boundary cost. Its value is, in precedence order: the client's explicit "pause before reply" setting sent on the start frame, else `liveVoice.vad.silenceThresholdMs` (schema default **1200**, `config/schemas/live-voice.ts`), else the in-code `DEFAULT_SILENCE_THRESHOLD_MS` of **800** (`live-voice-session.ts`). In a real daemon run the factory always seeds the config value, so **1200 is the number to use** unless you set the web client's pause slider or overrode the config key. The 800 constant only governs a session built with no `liveVoice` config at all, which in practice means tests. A code comment near `createLiveVoiceSession` still claims the schema default is 800; the schema is the authority and it says 1200.
- `endpointExtensionMs` defaults to **1500** and `endpointMaxExtensions` to **2**, so a fully held turn can absorb up to 3000ms of extension on top of everything else.
- It is `>=`, not `=`, because `endpointDecisionMaxLatencyMs` is the **worst single** roundtrip in the turn, not their sum. A turn with two holds paid two roundtrips and the frame reports one of them.

Worked example with the defaults, one hold, and an 800ms decider roundtrip:

```
1200 + (1 * 1500) + 800  =  3500 ms
```

A Flux turn reporting `endpointDecisionMaxLatencyMs: 450` is being compared against 3500ms, not against 800ms.

### Two more reasons the raw comparison misleads

- **The front door only records a decision when it holds.** `markEndpointDecision` is called from exactly two places: the Flux commit, and the hold verdict. A front-door turn that committed straight through the boundary emits **no** `endpoint_decision` at all, and the metrics frame carries none of the three endpoint fields. So the population of front-door samples is "turns the model judged mid-thought", which is the slow tail by construction, while the Flux population is every turn. Do not read a mean across the two as if they were the same denominator.
- **On a non-held front-door turn the roundtrip is not added latency.** The speculative leg dispatched at the boundary _is_ the assistant turn. If the model does not return the hold token, generation has already been running since the boundary. So an unheld front-door turn's added end-of-turn cost is just `silenceThresholdMs`. That is the real bar Flux has to beat on the common case, and it is a lower bar than the held-turn arithmetic above.

### The cross-check that needs no correction

The per-turn timestamps in the metrics snapshot are absolute and come from one clock, and both paths stamp `utteranceEndAtMs` at the moment the turn commits (`markUtteranceReleased` runs inside `releaseUtterance`, which both paths call). `speechStartAtMs` is stamped at local VAD onset and is first-wins, so it survives a pause the front door held across.

```
utteranceEndAtMs - speechStartAtMs
```

Say the **same scripted sentence** on both arms, and the difference between the arms in that figure is the endpointing cost, with no arithmetic and no source-specific semantics. Use this to sanity-check whatever the corrected `endpointDecisionMaxLatencyMs` comparison tells you. If the two disagree, trust this one.

---

## 1. Credentials

Flux shares the existing Deepgram credential. `credentialProvider: "deepgram"` in `providers/speech-to-text/provider-catalog.ts`, so there is **no new key to obtain and nowhere new to put it**. If `deepgram` already transcribes for you, Flux already has what it needs.

If it does not, set the Deepgram key the ordinary way (client Settings, Speech-to-text card) and pick either Deepgram entry; both write the same `deepgram` credential.

## 2. Enable Flux

> **Setting `services.stt.provider` to `deepgram-flux` turns off batch transcription for the whole workspace, not just live voice.** `services.stt.provider` is the single source of truth for every STT route, and Flux is the only provider in the catalog with no `daemon-batch` boundary. For as long as it is set, these all stop working: voice-message and inbound-attachment transcription, the `transcribe` skill, the `media-processing` skill's audio segments, `POST /v1/stt/transcribe`, and phone-call transcription. Each reports a message naming Flux as the cause rather than failing silently, but they do not fall back to `deepgram` on their own. **Set `services.stt.provider` back to `deepgram` when the spike is over**, and do not run the spike on an assistant that is also taking calls or handling voice messages.

Two keys in `config.json`, which lives at `$VELLUM_WORKSPACE_DIR/config.json` (default `~/.vellum/workspace/config.json`):

```json
{
  "services": {
    "stt": {
      "provider": "deepgram-flux"
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

| Key                 | Default           | Range        | Notes                                                                    |
| ------------------- | ----------------- | ------------ | ------------------------------------------------------------------------ |
| `model`             | `flux-general-en` | any string   | English only in this spike.                                              |
| `eotThreshold`      | `0.7`             | 0.5 to 0.9   | Lower commits sooner and cuts speakers off more; higher adds latency.    |
| `eagerEotThreshold` | _unset_           | 0.3 to 0.9   | Leave it unset. See "Known gaps".                                        |
| `eotTimeoutMs`      | `5000`            | 500 to 60000 | Silence after which Flux force-ends a turn it never got confident about. |

## 3. Run the A/B

**Flip `turnEnd.enabled` between runs and leave `services.stt.provider` on `deepgram-flux` in both arms.** That holds the STT engine, the model, the socket, and the transcriber lifecycle constant, so the only thing that changes is which signal commits the turn.

- **Arm A (control):** `provider: "deepgram-flux"`, `turnEnd.enabled: false`. Flux transcribes; the four turn-detection events are ignored; the local silence boundary and the front-door hold path run exactly as they do today.
- **Arm B (treatment):** `provider: "deepgram-flux"`, `turnEnd.enabled: true`.

**Do not A/B by switching the provider between `deepgram` and `deepgram-flux`.** That confounds two changes at once:

1. It swaps the STT model, so any transcript-quality or first-partial difference lands in your latency numbers.
2. It swaps the transcriber lifecycle. `deepgram` implements `finalizeUtterance`, so the session adopts it as a persistent stream shared across the whole session. Flux deliberately does not implement it, so every utterance dials a fresh `/v2/listen` socket. That is a per-turn connection setup you would be attributing to turn detection.

Say the same scripted set of utterances in both arms. Include at least a few deliberate mid-sentence thinking pauses, because that is the case the hold path exists for and the case Flux has to not regress.

### What this A/B still does not hold constant

With Flux as the provider in both arms, the transcript **final** arrives at different moments. In arm B the `EndOfTurn` frame emits `final` immediately before `turn-end`, so the final is already in hand at commit. In arm A the local boundary fires first and release calls `stop()`, which sends `CloseStream` and waits for Flux to flush. So `sttMs` (the `utteranceEnd` to `finalTranscript` span) is not comparable between arms. It is not the headline number, but do not read a regression into it.

## 4. Read the numbers

The daemon sends a `metrics` frame over the live-voice WebSocket on `turn_completed`, `turn_cancelled`, and `session_ended`. The three endpoint fields are flattened onto that frame by `getLiveVoiceMetricsAggregateFields`:

| Field                          | Meaning                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `endpointDecisionSource`       | `"flux"` or `"front-door"`. Present only when an endpoint decision was recorded.                 |
| `endpointDecisionMaxLatencyMs` | The headline number, subject to the correction above. Worst single decision latency in the turn. |
| `endpointHoldCount`            | Hold verdicts in the turn. Always 0 on a Flux-committed turn.                                    |

All three are **absent** unless a decision was recorded, which is deliberate: the absence is itself the signal.

**How to see them.** The web client stores the whole frame but its `console.debug("[live-voice] turn latency", ...)` line does not print the endpoint fields. Read them from the raw frame instead: DevTools, Network, WS, select the live-voice socket, filter frames for `"type":"metrics"`, and read the `turn_completed` frames. The per-turn `metrics.recentTurns[]` array in the same frame carries the `timestamps` you need for the cross-check in the first section.

### Reading an arm-B turn

| What you see                           | What happened                                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpointDecisionSource: "flux"`       | Flux committed the turn. This is the measurement you came for.                                                                                |
| No endpoint fields at all              | The fail-open deadline fired, the utterance fell back to the silence path, and the front door released it without holding. Not a Flux sample. |
| `endpointDecisionSource: "front-door"` | Same fallback, but the front door then held. Not a Flux sample either.                                                                        |

Fallbacks are logged at `warn`, so they are visible at the default log level:

```
No Flux end-of-turn is coming; falling back to the silence boundary for this utterance
```

The deadline is `liveVoice.flux.eotTimeoutMs` plus a 1000ms margin (`FLUX_TURN_END_FALLBACK_MARGIN_MS`), measured from the local speech-stop mark. If you see these routinely, you are measuring the fallback path, not Flux.

### Prefer medians, and do not chase a single bad sample

Per-turn Flux latency has a known outlier mode. If the caller resumes speaking and stops again before a delayed `turn-end` lands, the second boundary re-stamps `fluxBoundaryGeneration`, so `isStaleFluxTurnEnd` no longer recognizes the in-flight event as stale and accepts it. The **commit is still correct** (the caller has finished, and the transcript is the accumulated one), but `msSinceLocalSpeechStop()` measures from the newer speech-stop, so the recorded latency is wrong for that turn.

This is not fixable session-side. It needs Flux's turn id carried on the `turn-end` event so the session can match the event to the boundary it closed. Until then, report medians over a run of turns and ignore individual extremes.

## 5. Confirm the session is really running Flux

The dialed URL is logged at `info` on every session open, and it carries the clamped query parameters. The API key travels in an `Authorization` header, never in the URL, so the log line is safe to read and paste.

```
grep "Opening Deepgram Flux session" ~/.vellum/workspace/data/logs/assistant-*.log
```

Check the URL is `/v2/listen` and contains `model=flux-general-en`, `eot_threshold`, `eot_timeout_ms`, and **no** `eager_eot_threshold`. That is the cheapest confirmation that the tuning you wrote is the tuning in force.

`ConfigureSuccess` frames would carry Deepgram's authoritative `thresholds` and the adapter logs them at `debug`, but nothing in the adapter ever sends a mid-stream `Configure`, so that line does not appear in practice. The dialed URL is the confirmation you actually have.

### Seeing the debug lines

The pino level is hardcoded to `info` in `src/util/logger.ts`. Two useful lines are at `debug` and will **not** appear in a normal run:

- The per-session chunk cadence line (below).
- `Dropping a stale Flux end-of-turn: the caller resumed speaking past the boundary it closed`.

To see them, temporarily change the `level: "info"` values in `getRootLogger` / `buildRotatingLogger` to `"debug"`. There is no config key or env var for it.

## 6. Chunk cadence

Deepgram recommends 80ms audio chunks for Flux. Capture cadence is a client concern and this spike does not change it, but the adapter makes it measurable from the daemon side: once per session, on the first audio frame, it logs at `debug`

```
Deepgram Flux audio chunk cadence
```

with `byteLength`, `sampleRate`, `encoding`, `observedChunkMs`, and `recommendedChunkMs: 80`. `observedChunkMs` is derived from byte length and the negotiated sample rate and is only present for `linear16`, which is the default encoding. Read it before anyone proposes tuning the client; if it is already near 80 there is nothing to win there.

## 7. Known gaps

Do not rediscover these.

- **English only.** The spike pins `flux-general-en`. No language is forwarded to the adapter, because `language_hint` means nothing to a monolingual model. The web language catalog is untouched.
- **No telephony, and no fallback either.** The catalog entry sets `telephonyMode: "none"`, so `resolveTelephonySttCapability` reports Flux as unsupported and the call session reports that as its error. Nothing reroutes the call to the `deepgram` provider: with Flux configured, calls on this assistant are not transcribed at all.
- **No batch, workspace-wide.** `supportedBoundaries` is `daemon-streaming` only, and `resolveBatchTranscriber` throws for it rather than returning the `null` that every batch caller reports as "no speech-to-text provider is configured". Callers surface the thrown message instead: `Deepgram Flux is streaming-only. Batch transcription requires the deepgram provider: set services.stt.provider to "deepgram".` See the warning in section 2 for the full list of surfaces this takes down.
- **No managed / velay path.** This is BYOK through the daemon only. The relay pins the model server-side, so managed rollout is a relay change.
- **Eager end-of-turn is off, and its being off is load-bearing.** `eagerEotThreshold` is optional with no default, and leaving it unset is precisely what stops Deepgram emitting `EagerEndOfTurn` / `TurnResumed` at all. The parser handles both frames and the session no-ops them, so the follow-up is small, but Deepgram warns that enabling speculation raises LLM calls by 50 to 70 percent. Note also that `buildFluxQueryParams` clamps `eager_eot_threshold` **down** to the effective `eot_threshold`, because Deepgram rejects the inverse combination.
- **The hold machinery is present and unchanged.** `HOLD_VERDICT_TOKEN`, the `includeHold` branch, the speculative dispatch and rollback state, `endpointExtensionMs`, and `endpointMaxExtensions` are all still there. The latch only skips them.
- **Local VAD still owns barge-in in both modes,** and must. A local energy gate on audio already in hand beats a provider roundtrip for an interrupt during playback, and the echo-adaptive part of the guard has to stay upstream of Flux, which hears only the microphone and cannot tell our own TTS bleeding through imperfect echo cancellation from a real caller turn.
- **Self-hosted bundles and `KeepAlive`.** The adapter sends a `KeepAlive` control frame every 5s, which cloud `/v2/listen` accepts and which is the only thing that resets Deepgram's server-side inactivity timer during silence. Self-hosted SageMaker Flux bundles reject it as a fatal `UNPARSABLE_CLIENT_MESSAGE`. The escape hatch is the adapter's `keepaliveIntervalMs: 0` option, but it is a constructor option only: `resolve.ts` passes just `sampleRate`, so pointing the adapter at a self-hosted bundle means editing that call site. There is no config key for it.

### Two traps that were fixed, listed so you can check your build

Both are fixed on this branch. They matter only if you are measuring on an older build.

- **A first utterance during a slow STT dial used to run the old path while looking like a Flux session.** `start()` sends `ready` without waiting on the transcriber resolve, so the caller could speak and close a whole silence boundary while the handshake was still in flight, with the latch still on its default `false`. The latch is now seeded from the **configured** provider before the dial and reconciled against the resolved one afterwards. Symptom on an older build: the session's opening turn silently uses the front door.
- **The first turn's latency used to be anchored at zero rather than the real speech-stop,** inflating it. `msSinceLocalSpeechStop()` now returns 0 when no speech has been heard, and `fluxLastSpeechAtMs` is stamped on every above-gate chunk.

## 8. Falling back

Set `liveVoice.flux.turnEnd.enabled` back to `false` (or delete the key) and restart. That is the whole rollback: the latch goes down, the turn-detection events become no-ops, and the silence-boundary path runs unchanged. You can leave `services.stt.provider` on `deepgram-flux` or move it back to `deepgram`; either is a working configuration.

Runtime fallback needs no action. A Flux stream that never emits `turn-end` is caught by the fail-open deadline and the utterance replays onto the silence path, so an outage degrades to today's behavior rather than to a hung turn.

## 9. What would justify deleting the hold path

The follow-up cleanup is not small: `HOLD_VERDICT_TOKEN`, the `includeHold` branch of `frontDoorDecisionRule`, the `holdEnabled` parameter on `classifyFrontDoorLeading`, six pieces of speculative-dispatch state in the session, and the `endpointExtensionMs` / `endpointMaxExtensions` config surface. It is worth doing only if Flux clears a real bar. Deepgram claims Flux decides in under 400ms; that claim is the hypothesis under test here, not an input.

Suggested bar, all measured on the corrected basis from the first section, over enough turns for a median to mean something:

1. **Median end-of-turn latency beats the unheld front-door case.** That is `silenceThresholdMs` alone, so about 1200ms with the defaults. Beating the held case is easy and proves nothing, because most turns are not held.
2. **No regression on thinking pauses.** The hold path exists so a mid-sentence pause does not trigger a premature reply. Count premature commits on the scripted pause utterances in both arms. Flux has to be at least as good, not merely faster. A fast path that interrupts people is worse than the slow one.
3. **The fallback is rare.** If `warn`-level fallback lines appear on a meaningful fraction of turns, the hold path is not dead code, it is the live path, and deleting it removes the thing keeping the feature usable.
4. **Escalate and the spoken ack / progress phrasing still behave.** Flux bypasses only the `[0]` hold branch. Confirm `[1]` escalate still fires and acks still land before concluding the front door has nothing left to do.

If 1 and 2 both hold and 3 is clean, the cleanup is justified. If 1 holds but 2 does not, the answer is to tune `eotThreshold` upward and re-measure, not to delete anything.
