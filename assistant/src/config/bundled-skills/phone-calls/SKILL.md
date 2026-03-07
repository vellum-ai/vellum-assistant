---
name: "Phone Calls"
description: "Set up Twilio for AI-powered voice calls — both outgoing calls on behalf of the user and incoming calls where the assistant answers as a receptionist"
user-invocable: true
metadata:
  { "vellum": { "emoji": "📞", "requires": { "config": ["calls.enabled"] } } }
includes: ["public-ingress"]
---

You are helping the user set up and manage phone calls via Twilio. This skill covers enabling the calls feature, placing outbound calls, receiving inbound calls, and interacting with live calls. Twilio credential storage, phone number provisioning, and public ingress are handled by the **twilio-setup** skill.

## Overview

The calling system uses Twilio's ConversationRelay for both **outbound** and **inbound** voice calls with **ElevenLabs** providing the text-to-speech voice. After Twilio setup, the assistant configures ElevenLabs as the TTS provider and prompts the user to choose a voice from a curated list of supported options.

### Outbound calls

When a call is placed:

1. The assistant initiates an outbound call via the Twilio REST API
2. Twilio connects to the gateway's voice webhook, which returns TwiML
3. Twilio opens a ConversationRelay WebSocket for real-time voice streaming
4. An LLM-driven orchestrator manages the conversation — receiving caller speech (transcribed by Deepgram), generating responses via Claude, and streaming text back for TTS playback
5. The full transcript is stored in the database for later retrieval

### Inbound calls

When someone dials the assistant's Twilio phone number:

1. Twilio sends a voice webhook to the gateway at `/webhooks/twilio/voice` (no `callSessionId` in the URL)
2. The gateway resolves which assistant owns the dialed number via `resolveAssistantByPhoneNumber`, falling back to the standard routing chain (chat_id, user_id, default/reject). Unmapped numbers are rejected with TwiML `<Reject>`.
3. The runtime creates a new session keyed by the Twilio CallSid (`createInboundVoiceSession`)
4. Twilio opens a ConversationRelay WebSocket. The relay detects the call is inbound when `initiatedFromConversationId == null` and optionally gates the call behind **guardian voice verification** if a pending challenge exists.
5. Once verified (or if no challenge is pending), the LLM orchestrator greets the caller in a receptionist style: "Hello, this is [user]'s assistant. How can I help you today?"
6. The assistant converses naturally, using ASK_GUARDIAN to consult the user when needed, just like outbound calls.

The user's assistant gets its own personal phone number through Twilio. All implicit calls (without an explicit mode) always use this assistant number. Optionally, users can call from their own phone number if it's authorized with the Twilio account — this must be explicitly requested per call via `caller_identity_mode="user_number"`.

## Step 1: Verify Twilio Setup

Check whether Twilio credentials, phone number, and public ingress are already configured:

```bash
assistant config get twilio.accountSid
assistant credentials inspect twilio:auth_token --json  # check "hasSecret" field
assistant config get twilio.phoneNumber
```

```bash
assistant config get calls.enabled
```

If `twilio.accountSid` has a value, `hasSecret` is `true`, `twilio.phoneNumber` is set, and `calls.enabled` is `true`, skip to the **Making Outbound Calls** section.

If Twilio is not yet configured, load the **twilio-setup** skill — it handles credential storage, phone number provisioning, and public ingress setup:

- Call `skill_load` with `skill: "twilio-setup"` to load the dependency skill.

Once twilio-setup completes, return here to enable calls.

## Step 2: Enable Calls

Enable the calls feature:

```bash
assistant config set calls.enabled true
```

Verify:

```bash
assistant config get calls.enabled
```

## Step 3: Choose a Voice

After enabling calls, let the user choose an ElevenLabs voice. Twilio has a native ElevenLabs integration — no separate ElevenLabs account or API key is needed.

### Voice consistency with in-app TTS

The shared config key `elevenlabs.voiceId` is the single source of truth for ElevenLabs voice identity. Both in-app TTS and phone calls read from it (defaulting to **Rachel** — `21m00Tcm4TlvDq8ikWAM`).

Before presenting the voice list, check the current shared voice:

```bash
assistant config get elevenlabs.voiceId
```

**If a non-default voice is already set**, the user chose it during voice-setup or a previous session. Tell them:

> "Your assistant currently uses [voice name] for both in-app chat and phone calls. I'll keep the same voice for calls. You can change it if you'd like."

Skip the selection prompt unless the user wants to change.

**If the default (Rachel) is set or no override exists**, present the curated voice list below and let them pick. When they choose, set the shared config so both in-app TTS and phone calls use it:

### Voice selection

Present the user with a list of supported ElevenLabs voices. These are pre-made voices with stable IDs that work with Twilio ConversationRelay out of the box.

**Ask the user: "Which voice would you like your assistant to use on phone calls?"**

Present these voices grouped by category:

#### Female voices

| Voice     | Style                      | Voice ID               |
| --------- | -------------------------- | ---------------------- |
| Rachel    | Calm, warm, conversational | `21m00Tcm4TlvDq8ikWAM` |
| Sarah     | Soft, young, approachable  | `EXAVITQu4vr4xnSDxMaL` |
| Charlotte | Warm, Swedish-accented     | `XB0fDUnXU5powFXDhCwa` |
| Alice     | Confident, British         | `Xb7hH8MSUJpSbSDYk0k2` |
| Matilda   | Warm, friendly, young      | `XrExE9yKIg1WjnnlVkGX` |
| Lily      | Warm, British              | `pFZP5JQG7iQjIQuC4Bku` |

#### Male voices

| Voice   | Style                           | Voice ID               |
| ------- | ------------------------------- | ---------------------- |
| Antoni  | Warm, well-rounded              | `ErXwobaYiN019PkySvjV` |
| Josh    | Deep, young, clear              | `TxGEqnHWrfWFTfGW9XjX` |
| Arnold  | Crisp, narrative                | `VR6AewLTigWG4xSOukaG` |
| Adam    | Deep, middle-aged, professional | `pNInz6obpgDQGcFmaJgB` |
| Bill    | Trustworthy, American           | `pqHfZKP75CvOlQylNhV4` |
| George  | Warm, British, distinguished    | `JBFqnCBsd6RMkjVDRZzb` |
| Daniel  | Authoritative, British          | `onwK4e9ZLuTAKqWW03F9` |
| Charlie | Casual, Australian              | `IKne3meq5aSn9XLyUdCD` |
| Liam    | Young, articulate               | `TX3LPaxmHKxFdv7VOQHJ` |

After the user picks a voice, use `voice_config_update` to set the shared voice ID. This writes to the config file (`elevenlabs.voiceId`) for phone calls **and** pushes to the macOS app via IPC (`ttsVoiceId`) for in-app TTS in one call:

```
voice_config_update setting="tts_voice_id" value="<selected-voice-id>"
```

**If the user wants a voice not on this list**, they can browse more voices at https://elevenlabs.io/voice-library and provide the voice ID manually.

## Step 4: Verify Setup (Test Call)

Before making real calls, offer a quick verification:

1. Confirm credentials are stored: `assistant config get twilio.accountSid` should return a value and `assistant credentials inspect twilio:auth_token --json` should show `hasSecret: true`
2. Confirm phone number is assigned: `assistant config get twilio.phoneNumber` should return a number
3. Confirm ingress is running: `ingress.publicBaseUrl` must be set and the tunnel active
4. Confirm calls are enabled: `calls.enabled` must be `true`
5. Confirm voice is configured: `elevenlabs.voiceId` should be set

Suggest a test call to the user's own phone: **"Want to do a quick test call to your phone to make sure everything works? This is a good way to hear how your chosen voice sounds."**

If they agree, ask for their personal phone number and place a test call with a simple task like "Introduce yourself and confirm the call system is working."

## Step 5: Guardian Verification (Optional)

Link the user's phone number as the trusted voice guardian so the assistant can verify inbound callers.

Load the guardian-verify-setup skill with `channel: "phone"`:

```
skill_load skill=guardian-verify-setup
```

The skill handles the full verification flow (outbound call, code entry, confirmation). If the user declines, skip this step.

To re-check guardian status later:

```bash
assistant integrations guardian status --channel phone --json
```

## Caller Identity

All implicit calls (calls without an explicit `caller_identity_mode`) always use the assistant's Twilio phone number. This is the number that appears on the recipient's caller ID.

### User-number mode (per-call only)

If the user wants a specific call to appear as coming from their own phone number, they must explicitly pass `caller_identity_mode: 'user_number'` on that call. The user's phone number must be either owned by or verified with the same Twilio account.

**To configure a user phone number:**

```bash
assistant config set calls.callerIdentity.userNumber "+14155559999"
```

**To use it for a specific call**, pass `caller_identity_mode: 'user_number'` when calling `call_start` — see the Making Outbound Calls section for examples. User-number mode cannot be set as a global default; it must be requested explicitly per call.

### Configuration reference

| Setting                                     | Description                                      | Default   |
| ------------------------------------------- | ------------------------------------------------ | --------- |
| `calls.callerIdentity.allowPerCallOverride` | Whether per-call mode selection is allowed       | `true`    |
| `calls.callerIdentity.userNumber`           | Optional E.164 phone number for user-number mode | _(empty)_ |

## DTMF Callee Verification

An optional verification step where the callee must enter a numeric code via their phone's keypad (DTMF tones) before the call proceeds. This ensures the intended person has answered the phone.

### How it works

1. When the call connects and DTMF verification is enabled, a random numeric code is generated (length configured by `calls.verification.codeLength`).
2. The verification code is shared with the guardian in the initiating conversation so they know what code was issued.
3. The AI voice agent speaks the code digit-by-digit to the callee and asks them to enter it on their keypad.
4. The callee enters the code via DTMF (phone keypad tones).
5. If the code matches, the call proceeds normally. If the code is incorrect, the agent may re-prompt or end the call depending on configuration.

### Configuration

| Setting                         | Description                               | Default |
| ------------------------------- | ----------------------------------------- | ------- |
| `calls.verification.enabled`    | Enable DTMF callee verification           | `false` |
| `calls.verification.codeLength` | Number of digits in the verification code | `6`     |

## Advanced Voice Configuration

ElevenLabs is the TTS provider for all calls. This section covers advanced voice selection and tuning.

### Changing the voice

To switch to a different voice after initial setup, use `voice_config_update` to set the shared voice ID. This writes to the config file (`elevenlabs.voiceId`) for phone calls **and** pushes to the macOS app via IPC for in-app TTS:

```
voice_config_update setting="tts_voice_id" value="<new-voice-id>"
```

Browse more voices at https://elevenlabs.io/voice-library.

### Advanced voice selection with an ElevenLabs account

Users who have an ElevenLabs account and API key (e.g., from the **voice-setup** skill) can go beyond the curated voice list. With an API key, they can:

- **Browse the full ElevenLabs voice library programmatically** — the ElevenLabs API (`GET https://api.elevenlabs.io/v2/voices`) supports searching by name, category, language, and accent. This returns voice IDs, names, labels, and preview URLs.
- **Use custom or cloned voices** — if the user has created a custom voice or voice clone in their ElevenLabs account, they can use its voice ID here. These voices are available in Twilio ConversationRelay just like pre-made voices.
- **Preview voices before choosing** — each voice in the API response includes a `preview_url` with an audio sample.

To check if the user has an API key stored:

```bash
assistant credentials inspect elevenlabs:api_key --json
```

If they have a key and want to browse voices, fetch the voice list:

```bash
curl -s "https://api.elevenlabs.io/v2/voices?category=premade&page_size=50" \
  -H "xi-api-key: $(assistant credentials reveal elevenlabs:api_key)" | python3 -m json.tool
```

To search for a specific voice style:

```bash
curl -s "https://api.elevenlabs.io/v2/voices?search=warm+female&page_size=10" \
  -H "xi-api-key: $(assistant credentials reveal elevenlabs:api_key)" | python3 -m json.tool
```

After the user picks a voice, set the shared voice ID:

```
voice_config_update setting="tts_voice_id" value="<selected-voice-id>"
```

### Voice tuning parameters

Fine-tune how the selected voice sounds. These parameters apply to all ElevenLabs modes:

```bash
# Playback speed (0.7 = slower, 1.0 = normal, 1.2 = faster)
assistant config set elevenlabs.speed 1.0

# Stability (0.0 = more expressive/variable, 1.0 = more consistent/monotone)
assistant config set elevenlabs.stability 0.5

# Similarity boost (0.0 = more creative, 1.0 = closer to original voice)
assistant config set elevenlabs.similarityBoost 0.75
```

Lower stability makes the voice more expressive but less predictable — good for conversational calls. Higher stability is better for scripted/formal calls.

### Voice model tuning

By default, the system sends a **bare** `voiceId` to Twilio ConversationRelay (no model/tuning suffix). This is the safest default across voice IDs.

If you want to force Twilio's extended voice spec, you can optionally set a model ID:

```bash
assistant config set elevenlabs.voiceModelId "flash_v2_5"
```

When `voiceModelId` is set, the emitted voice string becomes:
`voiceId-model-speed_stability_similarity`.

## Making Outbound Calls

Use the `call_start` tool to place outbound calls. Every call requires:

- **phone_number**: The number to call in E.164 format (e.g. `+14155551234`)
- **task**: What the call should accomplish — this becomes the AI voice agent's objective
- **context** (optional): Additional background information for the conversation

### Example calls:

**Making a reservation:**

```
call_start phone_number="+14155551234" task="Make a dinner reservation for 2 people tonight at 7pm" context="The user's name is John Smith. Prefer a table by the window if available."
```

**Calling a business:**

```
call_start phone_number="+18005551234" task="Check if they have a specific product in stock" context="Looking for a 65-inch Samsung OLED TV, model QN65S95D. Ask about availability and price."
```

**Following up on an appointment:**

```
call_start phone_number="+12125551234" task="Confirm the dentist appointment scheduled for next Tuesday at 2pm" context="The appointment is under the name Jane Doe, DOB 03/15/1990."
```

### Caller identity in calls

Implicit calls always use the assistant's Twilio number (`assistant_number`). Only specify `caller_identity_mode` when the user explicitly requests a different identity for a specific call.

**Default call (assistant number):**

```
call_start phone_number="+14155551234" task="Check store hours for today"
```

**Call from the user's own number:**

```
call_start phone_number="+14155551234" task="Check store hours for today" caller_identity_mode="user_number"
```

**Decision rule:** Implicit calls (no explicit mode) always use the assistant's Twilio number. Only use `caller_identity_mode="user_number"` when the user explicitly requests it for a specific call.

### Phone number format

Phone numbers MUST be in E.164 format: `+` followed by country code and number with no spaces, dashes, or parentheses.

- US/Canada: `+1XXXXXXXXXX` (e.g. `+14155551234`)
- UK: `+44XXXXXXXXXX` (e.g. `+442071234567`)
- International: `+{country_code}{number}`

If the user provides a number in a different format, convert it to E.164 before calling. If the country is ambiguous, ask.

### Trial account limitations

On Twilio trial accounts, outbound calls can ONLY be made to **verified numbers**. If a call fails with a "not verified" error:

1. Tell the user they need to verify the number at https://console.twilio.com/us1/develop/phone-numbers/manage/verified
2. Or upgrade to a paid Twilio account to call any number

## Receiving Inbound Calls

Once Twilio is configured and the assistant has a phone number, inbound calls work automatically. When someone dials the assistant's number:

1. The gateway resolves the assistant by phone number and forwards to the runtime
2. A new voice session is created, keyed by the Twilio CallSid
3. The LLM-driven orchestrator answers in receptionist mode — greeting the caller warmly and asking how it can help
4. The conversation proceeds naturally, with ASK_GUARDIAN dispatches to consult the user when needed

No additional configuration is needed beyond Twilio setup and `calls.enabled` being `true`. As long as the phone number has been provisioned/assigned, inbound calls are handled automatically.

### Guardian voice verification for inbound calls

To set up guardian verification, load the skill: `skill_load skill=guardian-verify-setup`. Once a guardian binding exists, inbound callers may be prompted for verification before calls proceed.

## Interacting with a Live Call

During an active call, the user can interact with the AI voice agent via the HTTP API endpoints. After placing a call with `call_start`, use `call_status` to poll the call state.

#### Answering questions

When the AI voice agent encounters something it needs user input for, it dispatches an **ASK_GUARDIAN** request to all configured guardian channels (mac desktop, Telegram, SMS). The call status changes to `waiting_on_user`.

1. The question is delivered simultaneously to every configured channel. The first channel to respond wins (first-response-wins semantics) -- once one channel provides an answer, the other channels receive a "already answered" notice.
2. On the mac desktop, a guardian request thread is created with the question. On Telegram/SMS, the question text and a request code are delivered via the gateway.
3. If DTMF callee verification is enabled, the callee must enter a verification code before the call proceeds (see the **DTMF Callee Verification** section above).
4. The guardian provides an answer through whichever channel they prefer. The answer is routed to the AI voice agent, which continues the conversation naturally.

**Important:** Respond to pending questions quickly. There is a consultation timeout (default: 2 minutes). If no answer is provided in time, the AI voice agent will move on.

#### Guardian timeout and follow-up

When a consultation times out, the voice agent apologizes to the caller and moves on -- but the interaction is not lost. If the guardian responds after the timeout:

1. **Late reply detection**: The system recognizes the late answer on whichever channel it arrives (desktop, Telegram, or SMS) and presents a follow-up prompt asking the guardian what they would like to do.
2. **Follow-up options**: The guardian can choose to:
   - **Call back** the original caller with the answer
   - **Send a text message** to the caller with the answer
   - **Decline** if the follow-up is no longer needed
3. **Automatic execution**: If the guardian chooses to call back or send a message, the system resolves the original caller's phone number from the call record and executes the action automatically -- placing an outbound callback call or sending an SMS via the gateway.

All user-facing messages in this flow (timeout acknowledgments, follow-up prompts, completion confirmations) are generated by the assistant to maintain a natural, conversational tone. No fixed/canned responses are used.

The follow-up flow works across all guardian channels. The guardian can receive the timeout notice on Telegram, reply late via SMS, and choose to call back -- the system handles cross-channel routing transparently.

#### Steering with instructions

When there is **no pending question** but the call is still active, the user can send steering instructions via the HTTP API (`POST /v1/calls/:id/instruction`) to proactively guide the call in real time — for example:

- "Ask them about their cancellation policy too"
- "Wrap up the call, we have what we need"
- "Switch to asking about weekend availability instead"
- "Be more assertive about getting a discount"

The instruction is injected into the AI voice agent's conversation context as high-priority input, and the agent adjusts its behavior accordingly.

**Note:** Steering is done via the HTTP API, not the desktop chat thread. The desktop thread only receives pointer/status messages about the call.

### Call status values

- **initiated** — Call is being placed
- **ringing** — Phone is ringing on the other end
- **in_progress** — Call is connected, conversation is active
- **waiting_on_user** — AI agent needs input from the user (check pending question)
- **completed** — Call ended successfully
- **failed** — Call failed (check lastError for details)
- **cancelled** — Call was manually cancelled

### Ending a call early

Use `call_end` with the call session ID to terminate an active call:

```
call_end call_session_id="<session_id>" reason="User requested to end the call"
```

## Retrieving Past Call Transcripts

After a call ends, the full bidirectional transcript (caller speech, assistant responses, tool calls, and tool results) is stored in the SQLite database. The daemon logs (`vellum.log`) only contain caller-side transcripts and lifecycle events at the default log level, so they are **not sufficient** for full transcript reconstruction.

### Finding the conversation

1. **Get the call session ID and voice conversation ID** from `vellum.log` by searching for recent session creation entries:

```bash
grep "voiceConversationId" ~/.vellum/workspace/data/logs/vellum.log | tail -5
```

The `voiceConversationId` field in the `Created new inbound voice session` (or outbound equivalent) log line is the key you need.

2. **Query the messages table** in the SQLite database using the voice conversation ID:

```bash
sqlite3 ~/.vellum/workspace/data/db/assistant.db \
  "SELECT role, content FROM messages WHERE conversation_id = '<voiceConversationId>' ORDER BY created_at ASC;"
```

This returns all messages in chronological order with:

- `role: "user"` — caller speech (prefixed with `[SPEAKER]` tags) and system events
- `role: "assistant"` — assistant responses, including `text` content and any `tool_use`/`tool_result` blocks

### Quick one-liner for the most recent call

```bash
CONV_ID=$(grep "voiceConversationId" ~/.vellum/workspace/data/logs/vellum.log | tail -1 | python3 -c "import sys,json; print(json.loads(sys.stdin.readline().strip())['voiceConversationId'])")

sqlite3 ~/.vellum/workspace/data/db/assistant.db \
  "SELECT role, content FROM messages WHERE conversation_id = '$CONV_ID' ORDER BY created_at ASC;"
```

### Additional tables for call metadata

| Table                     | What it contains                                               |
| ------------------------- | -------------------------------------------------------------- |
| `call_sessions`           | Session metadata (start time, duration, phone numbers, status) |
| `call_events`             | Granular event log for the call lifecycle                      |
| `notification_decisions`  | Whether notifications were evaluated during the call           |
| `notification_deliveries` | Notification delivery attempts                                 |

### Key paths

| Resource                                      | Path                                       |
| --------------------------------------------- | ------------------------------------------ |
| Assistant logs (caller-side transcripts only) | `~/.vellum/workspace/data/logs/vellum.log` |
| Full conversation database                    | `~/.vellum/workspace/data/db/assistant.db` |
| Messages table                                | `messages` (keyed by `conversation_id`)    |
| Call sessions table                           | `call_sessions`                            |
| Call events table                             | `call_events`                              |

### Important

`vellum.log` at the default log level does **not** contain assistant responses, TTS text, or LLM completions for voice calls. Always use the `messages` table in `assistant.db` as the source of truth for complete call transcripts.

## Call Quality Tips

When crafting tasks for the AI voice agent, follow these guidelines for the best call experience:

### Writing good task descriptions

- **Be specific about the objective**: "Make a dinner reservation for 2 at 7pm tonight" is better than "Call the restaurant"
- **Include relevant context**: Names, account numbers, appointment details — anything the agent might need
- **Specify what information to collect**: "Ask about their return policy and store hours" tells the agent what to gather
- **Set clear completion criteria**: The agent knows to end the call when the task is fulfilled

### Providing context

The `context` field is powerful — use it to give the agent background that helps it sound natural:

- User's name and identifying details (for making appointments, verifying accounts)
- Preferences and constraints (dietary restrictions, budget limits, scheduling conflicts)
- Previous interaction history ("I called last week and spoke with Sarah about...")
- Special instructions ("If they put you on hold for more than 5 minutes, hang up and we'll try again later")

### Things the AI voice agent handles well

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

### Things to be aware of

- Calls have a maximum duration (configurable via `calls.maxDurationSeconds`, default: 1 hour)
- The agent gives a 2-minute warning before the time limit
- Emergency numbers (911, 112, 999, etc.) are blocked and cannot be called
- The AI disclosure setting (`calls.disclosure.enabled`) controls whether the agent announces it's an AI at the start of the call

## Configuration Reference

All call-related settings can be managed via `assistant config`:

| Setting                                     | Description                                                                                                                   | Default                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `calls.enabled`                             | Master switch for the calling feature                                                                                         | `false`                                                                                                  |
| `calls.provider`                            | Voice provider (currently only `twilio`)                                                                                      | `twilio`                                                                                                 |
| `calls.maxDurationSeconds`                  | Maximum call length in seconds                                                                                                | `3600` (1 hour)                                                                                          |
| `calls.userConsultTimeoutSeconds`           | How long to wait for user answers                                                                                             | `120` (2 min)                                                                                            |
| `calls.disclosure.enabled`                  | Whether the AI announces itself at call start                                                                                 | `true`                                                                                                   |
| `calls.disclosure.text`                     | The disclosure message spoken at call start                                                                                   | `"At the very beginning of the call, introduce yourself as an assistant calling on behalf of my human."` |
| `calls.model`                               | Override LLM model for call orchestration                                                                                     | _(uses default model)_                                                                                   |
| `calls.callerIdentity.allowPerCallOverride` | Allow per-call caller identity selection                                                                                      | `true`                                                                                                   |
| `calls.callerIdentity.userNumber`           | E.164 phone number for user-number mode                                                                                       | _(empty)_                                                                                                |
| `calls.voice.language`                      | Language code for TTS and transcription                                                                                       | `en-US`                                                                                                  |
| `calls.voice.transcriptionProvider`         | Speech-to-text provider (`Deepgram`, `Google`)                                                                                | `Deepgram`                                                                                               |
| `elevenlabs.voiceId`                        | ElevenLabs voice ID used by both in-app TTS and phone calls. Set during setup from the curated voice list. Defaults to Rachel | `21m00Tcm4TlvDq8ikWAM`                                                                                   |
| `elevenlabs.voiceModelId`                   | Optional Twilio ConversationRelay model suffix. Leave empty to send bare `voiceId`                                            | _(empty)_                                                                                                |
| `elevenlabs.speed`                          | Playback speed (`0.7` – `1.2`)                                                                                                | `1.0`                                                                                                    |
| `elevenlabs.stability`                      | Voice stability (`0.0` – `1.0`)                                                                                               | `0.5`                                                                                                    |
| `elevenlabs.similarityBoost`                | Voice similarity boost (`0.0` – `1.0`)                                                                                        | `0.75`                                                                                                   |

### Adjusting settings

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

## Troubleshooting

### "Twilio credentials not configured"

Load the `twilio-setup` skill to store your Account SID and Auth Token.

### "Calls feature is disabled"

Run `assistant config set calls.enabled true`.

### "No public base URL configured"

Run the **public-ingress** skill to set up ngrok and configure `ingress.publicBaseUrl`.

### Call fails immediately after initiating

- Check that the phone number is in E.164 format
- Verify Twilio credentials are correct (wrong auth token causes API errors)
- On trial accounts, ensure the destination number is verified
- Check that the ngrok tunnel is still running (`curl -s http://127.0.0.1:4040/api/tunnels`)

### Call connects but no audio / one-way audio

- The ConversationRelay WebSocket may not be connecting. Check that `ingress.publicBaseUrl` is correct and the tunnel is active
- Verify the assistant runtime is running

### "Number not eligible for caller identity"

The user's phone number is not owned by or verified with the Twilio account. The number must be either purchased through Twilio or added as a verified caller ID at https://console.twilio.com/us1/develop/phone-numbers/manage/verified.

### "Per-call caller identity override is disabled"

The setting `calls.callerIdentity.allowPerCallOverride` is set to `false`, so per-call `caller_identity_mode` selection is not allowed. Re-enable overrides with `assistant config set calls.callerIdentity.allowPerCallOverride true`.

### Caller identity call fails on trial account

Twilio trial accounts can only place calls to verified numbers, regardless of caller identity mode. The user's phone number must also be verified with Twilio. Upgrade to a paid account or verify both the source and destination numbers.

### "This phone number is not allowed to be called"

Emergency numbers (911, 112, 999, 000, 110, 119) are permanently blocked for safety.

### ngrok tunnel URL changed

If you restarted ngrok, the public URL has changed. Update it:

```bash
assistant config set ingress.publicBaseUrl "<new-url>"
```

Or re-run the public-ingress skill to auto-detect and save the new URL.

### Call drops after 30 seconds of silence

The system has a 30-second silence timeout. If nobody speaks for 30 seconds during normal conversation, the agent will ask "Are you still there?" This is expected behavior. During guardian wait states (inbound access-request wait or in-call guardian consultation wait), this generic silence nudge is suppressed — the guardian-wait heartbeat messaging is used instead.

### Call quality sounds off

- Verify `elevenlabs.voiceId` is set to a valid ElevenLabs voice ID
- Ask for the desired voice style again and try a different voice selection

### Twilio says "application error" right after answer

- This often means ConversationRelay rejected voice configuration after TwiML fetch
- Keep `elevenlabs.voiceModelId` empty first (bare `voiceId` mode)
- If you set `voiceModelId`, try clearing it and retesting:
  `assistant config set elevenlabs.voiceModelId ""`
