# Configuration Reference

All call-related settings can be managed via `assistant config`:

| Setting                                     | Description                                                                                                                                                                                                                               | Default                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `calls.enabled`                             | Master switch for the calling feature                                                                                                                                                                                                     | `true`                                                                                                   |
| `calls.provider`                            | Voice provider (currently only `twilio`)                                                                                                                                                                                                  | `twilio`                                                                                                 |
| `calls.maxDurationSeconds`                  | Maximum call length in seconds                                                                                                                                                                                                            | `3600` (1 hour)                                                                                          |
| `calls.userConsultTimeoutSeconds`           | How long to wait for user answers                                                                                                                                                                                                         | `120` (2 min)                                                                                            |
| `calls.disclosure.enabled`                  | Whether the AI announces itself at call start                                                                                                                                                                                             | `true`                                                                                                   |
| `calls.disclosure.text`                     | The disclosure message spoken at call start                                                                                                                                                                                               | `"At the very beginning of the call, introduce yourself as an assistant calling on behalf of my human."` |
| `llm.callSites.callAgent.model`             | Override LLM model for call orchestration                                                                                                                                                                                                 | _(unset — falls back to the resolved call-site default)_                                                 |
| `calls.callerIdentity.allowPerCallOverride` | Allow per-call caller identity selection                                                                                                                                                                                                  | `true`                                                                                                   |
| `calls.callerIdentity.userNumber`           | E.164 phone number for user-number mode                                                                                                                                                                                                   | _(empty)_                                                                                                |
| `calls.voice.language`                      | Language code for TTS and transcription                                                                                                                                                                                                   | `en-US`                                                                                                  |
| `services.stt.provider`                     | STT provider for transcription and telephony. The assistant transcribes call audio itself over the Twilio media stream (streaming when the provider supports it, batch otherwise), so calls require a working API key for this provider.  | `deepgram`                                                                                               |
| `services.tts.provider`                     | Active TTS provider for speech synthesis. Must be a provider ID from the catalog (`elevenlabs`, `fish-audio`, `deepgram`, `xai`). New providers can be added via the catalog without code changes to call routing.                        | `elevenlabs`                                                                                             |
| `services.tts.providers.<id>.*`             | Provider-specific settings block. Each catalog provider has its own settings namespace under `services.tts.providers.<id>`. See voice settings in the desktop/iOS app or run `assistant config list` for available settings per provider. | _(per-provider defaults)_                                                                                |

## TTS provider call-path behavior

During phone calls the assistant synthesizes audio server-side via the configured provider's API, transcodes it to mu-law, and streams it to Twilio over the media stream. Each provider's catalog entry declares its playback format:

| Provider     | Playback format | Description                                                                                      |
| ------------ | --------------- | ------------------------------------------------------------------------------------------------ |
| `elevenlabs` | `pcm`           | Synthesizes PCM audio via the ElevenLabs API.                                                    |
| `fish-audio` | `wav`           | Synthesizes WAV audio via Fish Audio's HTTP API. Requires a configured `referenceId`.            |
| `deepgram`   | `pcm`           | Synthesizes PCM audio via Deepgram's HTTP API. Uses the same API key as Deepgram speech-to-text. |
| `xai`        | `pcm`           | Streams PCM audio via xAI's WebSocket endpoint.                                                  |

Calls require a media-stream-playable TTS provider with a working API key. When the configured provider is not playable (unsupported format or missing credentials), the assistant falls back to a credentialed playable provider rather than letting the call go silent; if none exists, calls are blocked up front with a setup-required message.

## Adjusting settings

```bash
# Increase max call duration to 2 hours
assistant config set calls.maxDurationSeconds 7200

# Disable AI disclosure (check local regulations first)
assistant config set calls.disclosure.enabled false

# Custom disclosure message
assistant config set calls.disclosure.text "Just so you know, this is an assistant calling on behalf of my human."

# Give more time for user consultation
assistant config set calls.userConsultTimeoutSeconds 300
```

# Call Quality Tips

When crafting tasks for the AI voice agent, follow these guidelines for the best call experience:

## Writing good task descriptions

- **Be specific about the objective**: "Make a dinner reservation for 2 at 7pm tonight" is better than "Call the restaurant"
- **Include relevant context**: Names, account numbers, appointment details - anything the agent might need
- **Specify what information to collect**: "Ask about their return policy and store hours" tells the agent what to gather
- **Set clear completion criteria**: The agent knows to end the call when the task is fulfilled

## Providing context

The `context` field is powerful - use it to give the agent background that helps it sound natural:

- User's name and identifying details (for making appointments, verifying accounts)
- Preferences and constraints (dietary restrictions, budget limits, scheduling conflicts)
- Previous interaction history ("I called last week and spoke with Sarah about...")
- Special instructions ("If they put you on hold for more than 5 minutes, hang up and we'll try again later")

## Things the AI voice agent handles well

**Outbound calls:**

- Making reservations and appointments
- Checking business hours, availability, or pricing
- Confirming or rescheduling existing appointments
- Gathering information (store policies, product availability)
- Simple customer service interactions
- Leaving voicemails (it will speak the message if voicemail picks up)

**Inbound calls:**

- Answering as a receptionist and routing caller requests to the user via ASK_GUARDIAN
- Taking messages when the user is unavailable
- Answering questions the assistant already knows from memory/context
- Screening calls with guardian voice verification

## Things to be aware of

- Calls have a maximum duration (configurable via `calls.maxDurationSeconds`, default: 1 hour)
- The agent gives a 2-minute warning before the time limit
- Emergency numbers (911, 112, 999, etc.) are blocked and cannot be called
- The AI disclosure setting (`calls.disclosure.enabled`) controls whether the agent announces it's an AI at the start of the call
