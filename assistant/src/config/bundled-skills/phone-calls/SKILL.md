---
name: "Phone Calls"
description: "Set up Twilio for outgoing phone calls and place AI-powered voice calls on behalf of the user"
user-invocable: true
metadata: {"vellum": {"emoji": "📞", "requires": {"config": ["calls.enabled"]}}}
includes: ["public-ingress"]
---

You are helping the user set up and make outgoing phone calls via Twilio. This skill covers the full lifecycle: Twilio account setup, credential storage, public ingress configuration, enabling the calls feature, placing calls, and monitoring live transcripts.

## Overview

The calling system uses Twilio's ConversationRelay to place outbound phone calls. Twilio works out of the box as the default voice provider. Optionally, you can enable ElevenLabs integration for higher-quality, more natural-sounding voices — but this is entirely optional.

When a call is placed:

1. The assistant initiates an outbound call via the Twilio REST API
2. Twilio connects to the gateway's voice webhook, which returns TwiML
3. Twilio opens a ConversationRelay WebSocket for real-time voice streaming
4. An LLM-driven orchestrator manages the conversation — receiving caller speech (transcribed by Deepgram), generating responses via Claude, and streaming text back for TTS playback
5. The transcript is relayed live to the user's conversation thread

Three voice quality modes are available:
- **`twilio_standard`** (default) — Standard Twilio TTS with Google voices. No extra setup required.
- **`twilio_elevenlabs_tts`** — Uses ElevenLabs voices through Twilio ConversationRelay for more natural speech.
- **`elevenlabs_agent`** — Full ElevenLabs conversational agent mode for the highest quality (requires ElevenLabs agent setup).

You can keep using Twilio only — no changes needed. Enabling ElevenLabs can improve naturalness and quality.

The user's assistant gets its own personal phone number through Twilio. By default, all outbound calls are placed from this assistant number. Optionally, users can call from their own phone number if it's authorized with the Twilio account — this is called "caller identity mode" and can be configured as a default or selected per-call.

## Step 1: Check Current Configuration

First, check whether Twilio is already configured:

```bash
vellum config get calls.enabled
```

Also check for existing credentials:

```bash
credential_store action=get service=credential:twilio:account_sid
credential_store action=get service=credential:twilio:auth_token
credential_store action=get service=credential:twilio:phone_number
```

If all three credentials exist and `calls.enabled` is `true`, skip to the **Making Calls** section. If credentials are partially configured, skip to whichever step is still needed.

## Step 2: Create a Twilio Account

If the user doesn't have a Twilio account yet, guide them through setup:

1. Tell the user: **"You'll need a Twilio account to make phone calls. Sign up at https://www.twilio.com/try-twilio — it's free to start and includes trial credit."**
2. Once they have an account, they need three pieces of information:
   - **Account SID** — found on the Twilio Console dashboard at https://console.twilio.com
   - **Auth Token** — found on the same dashboard (click "Show" to reveal it)
   - **Phone Number** — a Twilio phone number capable of making voice calls

### Getting a Twilio Phone Number

If the user doesn't have a Twilio phone number yet:

1. Direct them to https://console.twilio.com/us1/develop/phone-numbers/manage/incoming
2. Click **"Buy a Number"**
3. Select a number with **Voice** capability enabled
4. For trial accounts, Twilio provides one free number automatically — check "Active Numbers" first

Tell the user: **"This will be your assistant's personal phone number — the number that shows up on caller ID when calls are placed."**

## Step 3: Store Twilio Credentials

Once the user provides their credentials, store them securely using the `credential_store` tool. Ask the user to paste each value, then store them one at a time:

**Account SID:**
```
credential_store action=set service=credential:twilio:account_sid value=<their_account_sid>
```

**Auth Token:**
```
credential_store action=set service=credential:twilio:auth_token value=<their_auth_token>
```

**Phone Number** (must be in E.164 format, e.g. `+14155551234`):
```
credential_store action=set service=credential:twilio:phone_number value=<their_phone_number>
```

After storing, verify each credential was saved:
```
credential_store action=get service=credential:twilio:account_sid
credential_store action=get service=credential:twilio:auth_token
credential_store action=get service=credential:twilio:phone_number
```

**Important:** Credentials are stored in the OS keychain (macOS Keychain / Linux secret-service) or encrypted at rest. They are never logged or exposed in plaintext.

## Step 4: Set Up Public Ingress

Twilio needs a publicly reachable URL to send voice webhooks and establish the ConversationRelay WebSocket. The **public-ingress** skill handles this via ngrok.

Check if ingress is already configured:

```bash
vellum config get ingress.publicBaseUrl
vellum config get ingress.enabled
```

If not configured, load and run the public-ingress skill:

```
skill_load skill=public-ingress
```

Follow the public-ingress skill's instructions to set up the ngrok tunnel. Once complete, the gateway will be reachable at the configured `ingress.publicBaseUrl`.

**Twilio needs these webhook endpoints (handled automatically by the gateway):**
- Voice webhook: `{publicBaseUrl}/webhooks/twilio/voice`
- Status callback: `{publicBaseUrl}/webhooks/twilio/status`
- ConversationRelay WebSocket: `{publicBaseUrl}/webhooks/twilio/relay` (wss://)

No manual Twilio webhook configuration is needed — the assistant registers webhook URLs dynamically when placing each call.

## Step 5: Enable Calls

Enable the calls feature:

```bash
vellum config set calls.enabled true
```

Verify:
```bash
vellum config get calls.enabled
```

## Step 6: Verify Setup (Test Call)

Before making real calls, offer a quick verification:

1. Confirm credentials are stored: all three `credential:twilio:*` keys must be present
2. Confirm ingress is running: `ingress.publicBaseUrl` must be set and the tunnel active
3. Confirm calls are enabled: `calls.enabled` must be `true`

Suggest a test call to the user's own phone: **"Want to do a quick test call to your phone to make sure everything works?"**

If they agree, ask for their personal phone number and place a test call with a simple task like "Introduce yourself and confirm the call system is working."

## Caller Identity

By default, calls are placed from the assistant's Twilio phone number (the one stored as `credential:twilio:phone_number`). This is the number that appears on the recipient's caller ID.

### User-number mode

If the user wants calls to appear as coming from their own phone number instead, they can enable **user-number mode**. The user's phone number must be either owned by or verified with the same Twilio account.

**To configure a user phone number:**

```
credential_store action=set service=credential:twilio:user_phone_number value=+14155559999
```

**To set user-number mode as the default:**

```bash
vellum config set calls.callerIdentity.defaultMode user_number
```

**To use it for a single call** (without changing the default), pass `caller_identity_mode: 'user_number'` when calling `call_start` — see the Making Calls section for examples.

### Configuration reference

| Setting | Description | Default |
|---|---|---|
| `calls.callerIdentity.defaultMode` | Which number to use as caller ID: `assistant_number` or `user_number` | `assistant_number` |
| `calls.callerIdentity.allowPerCallOverride` | Whether per-call mode selection is allowed | `true` |
| `calls.callerIdentity.userNumber` | Optional E.164 phone number for user-number mode (alternative to storing via `credential_store`) | *(empty)* |

### Reverting to assistant number

To switch back to the default:

```bash
vellum config set calls.callerIdentity.defaultMode assistant_number
```

## Optional: Higher Quality Voice with ElevenLabs

ElevenLabs integration is entirely optional. The standard Twilio-only setup works unchanged — this section is only relevant if you want to improve voice quality.

### Mode: `twilio_elevenlabs_tts`

Uses ElevenLabs voices through Twilio's ConversationRelay. Speech is more natural-sounding than the default Google TTS voices. No ElevenLabs API key is needed for this mode — just a voice ID.

**Setup:**

1. Browse ElevenLabs voices at https://elevenlabs.io/voice-library and pick a voice ID
2. Set the voice mode and voice ID:

```bash
vellum config set calls.voice.mode twilio_elevenlabs_tts
vellum config set calls.voice.elevenlabs.voiceId "<your-voice-id>"
```

### Mode: `elevenlabs_agent`

Full ElevenLabs conversational agent mode. This requires an ElevenLabs account with an agent configured on their platform.

**Setup:**

1. Store your ElevenLabs API key securely:

```
credential_store action=set service=credential:elevenlabs:api_key value=<your_api_key>
```

2. Set the voice mode and agent ID:

```bash
vellum config set calls.voice.mode elevenlabs_agent
vellum config set calls.voice.elevenlabs.agentId "<your-agent-id>"
```

### Fallback behavior

By default, `calls.voice.fallbackToStandardOnError` is `true`. This means if ElevenLabs is unavailable or misconfigured (e.g., missing voice ID, API errors), calls automatically fall back to standard Twilio TTS rather than failing. You can disable this if you want strict ElevenLabs-only behavior:

```bash
vellum config set calls.voice.fallbackToStandardOnError false
```

### Reverting to standard Twilio

To go back to the default voice at any time:

```bash
vellum config set calls.voice.mode twilio_standard
```

## Making Calls

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

By default, calls use the configured default caller identity mode (see `calls.callerIdentity.defaultMode` — defaults to `assistant_number`). Only specify `caller_identity_mode` when you need to override the configured default for a specific call.

**Default call (assistant number):**
```
call_start phone_number="+14155551234" task="Check store hours for today"
```

**Call from the user's own number:**
```
call_start phone_number="+14155551234" task="Check store hours for today" caller_identity_mode="user_number"
```

**Decision rule:** Use the configured default mode (`calls.callerIdentity.defaultMode`) unless the user explicitly requests a different mode for this call. When the configured default is `assistant_number`, the assistant's Twilio number is used. When configured as `user_number`, the user's verified number is used.

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

## Live Call Monitoring

### Showing the live transcript

By default, always show the live transcript of the call as it happens. When a call is in progress:

1. After placing the call with `call_start`, immediately begin polling with `call_status` to track the call state
2. The system fires transcript notifications as the conversation unfolds — both caller speech and assistant responses appear in real time in the conversation thread
3. Present each transcript entry clearly as it arrives:

```
📞 Call in progress...

🗣️ Assistant: "Hi, I'm calling on behalf of John to make a dinner reservation for tonight."
👤 Caller: "Sure, what time would you like?"
🗣️ Assistant: "We'd like a table for two at 7pm, please."
👤 Caller: "Let me check... yes, we have availability at 7pm."
🗣️ Assistant: "Wonderful! The reservation would be under John Smith."
```

4. Continue monitoring until the call completes or fails

### Handling questions during a call

The AI voice agent may encounter situations where it needs input from the user. When this happens:

1. The call status changes to `waiting_on_user`
2. A **pending question** appears in `call_status` output
3. Present the question prominently to the user:

```
❓ The person on the call asked something the assistant needs your help with:
   "They're asking if you'd prefer the smoking or non-smoking section?"
```

4. The user can reply directly in the chat — their response is automatically routed to the live call via the call bridge
5. The AI voice agent receives the answer and continues the conversation naturally

**Important:** Respond to pending questions quickly. There is a consultation timeout (default: 2 minutes). If no answer is provided in time, the AI voice agent will move on.

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

- Making reservations and appointments
- Checking business hours, availability, or pricing
- Confirming or rescheduling existing appointments
- Gathering information (store policies, product availability)
- Simple customer service interactions
- Leaving voicemails (it will speak the message if voicemail picks up)

### Things to be aware of

- Calls have a maximum duration (configurable via `calls.maxDurationSeconds`, default: 1 hour)
- The agent gives a 2-minute warning before the time limit
- Emergency numbers (911, 112, 999, etc.) are blocked and cannot be called
- The AI disclosure setting (`calls.disclosure.enabled`) controls whether the agent announces it's an AI at the start of the call

## Configuration Reference

All call-related settings can be managed via `vellum config`:

| Setting | Description | Default |
|---|---|---|
| `calls.enabled` | Master switch for the calling feature | `false` |
| `calls.provider` | Voice provider (currently only `twilio`) | `twilio` |
| `calls.maxDurationSeconds` | Maximum call length in seconds | `3600` (1 hour) |
| `calls.userConsultTimeoutSeconds` | How long to wait for user answers | `120` (2 min) |
| `calls.disclosure.enabled` | Whether the AI announces itself at call start | `true` |
| `calls.disclosure.text` | The disclosure message spoken at call start | `"I should let you know that I'm an AI assistant calling on behalf of my user."` |
| `calls.model` | Override LLM model for call orchestration | *(uses default model)* |
| `calls.callerIdentity.defaultMode` | Default caller ID mode: `assistant_number` or `user_number` | `assistant_number` |
| `calls.callerIdentity.allowPerCallOverride` | Allow per-call caller identity selection | `true` |
| `calls.callerIdentity.userNumber` | E.164 phone number for user-number mode | *(empty)* |
| `calls.voice.mode` | Voice quality mode (`twilio_standard`, `twilio_elevenlabs_tts`, `elevenlabs_agent`) | `twilio_standard` |
| `calls.voice.language` | Language code for TTS and transcription | `en-US` |
| `calls.voice.transcriptionProvider` | Speech-to-text provider (`Deepgram`, `Google`) | `Deepgram` |
| `calls.voice.fallbackToStandardOnError` | Auto-fallback to standard Twilio TTS on ElevenLabs errors | `true` |
| `calls.voice.elevenlabs.voiceId` | ElevenLabs voice ID (for `twilio_elevenlabs_tts` mode) | *(empty)* |
| `calls.voice.elevenlabs.agentId` | ElevenLabs agent ID (for `elevenlabs_agent` mode) | *(empty)* |

### Adjusting settings

```bash
# Increase max call duration to 2 hours
vellum config set calls.maxDurationSeconds 7200

# Disable AI disclosure (check local regulations first)
vellum config set calls.disclosure.enabled false

# Custom disclosure message
vellum config set calls.disclosure.text "Just so you know, this is an AI assistant calling for my user."

# Give more time for user consultation
vellum config set calls.userConsultTimeoutSeconds 300
```

## Troubleshooting

### "Twilio credentials not configured"
Run Step 3 to store your Account SID, Auth Token, and Phone Number via `credential_store`.

### "Calls feature is disabled"
Run `vellum config set calls.enabled true`.

### "No public base URL configured"
Run the **public-ingress** skill to set up ngrok and configure `ingress.publicBaseUrl`.

### Call fails immediately after initiating
- Check that the phone number is in E.164 format
- Verify Twilio credentials are correct (wrong auth token causes API errors)
- On trial accounts, ensure the destination number is verified
- Check that the ngrok tunnel is still running (`curl -s http://127.0.0.1:4040/api/tunnels`)

### Call connects but no audio / one-way audio
- The ConversationRelay WebSocket may not be connecting. Check that `ingress.publicBaseUrl` is correct and the tunnel is active
- Verify the gateway is running on `http://127.0.0.1:${GATEWAY_PORT:-7830}`

### "Number not eligible for caller identity"
The user's phone number is not owned by or verified with the Twilio account. The number must be either purchased through Twilio or added as a verified caller ID at https://console.twilio.com/us1/develop/phone-numbers/manage/verified.

### "Per-call caller identity override is disabled"
The setting `calls.callerIdentity.allowPerCallOverride` is set to `false`, so per-call `caller_identity_mode` selection is not allowed. Either change the default mode with `vellum config set calls.callerIdentity.defaultMode user_number`, or re-enable overrides with `vellum config set calls.callerIdentity.allowPerCallOverride true`.

### Caller identity call fails on trial account
Twilio trial accounts can only place calls to verified numbers, regardless of caller identity mode. The user's phone number must also be verified with Twilio. Upgrade to a paid account or verify both the source and destination numbers.

### "This phone number is not allowed to be called"
Emergency numbers (911, 112, 999, 000, 110, 119) are permanently blocked for safety.

### ngrok tunnel URL changed
If you restarted ngrok, the public URL has changed. Update it:
```bash
vellum config set ingress.publicBaseUrl "<new-url>"
```
Or re-run the public-ingress skill to auto-detect and save the new URL.

### Call drops after 30 seconds of silence
The system has a 30-second silence timeout. If nobody speaks for 30 seconds, the agent will ask "Are you still there?" This is expected behavior.

### Call quality didn't improve after enabling ElevenLabs
- Verify `calls.voice.mode` is set to `twilio_elevenlabs_tts` or `elevenlabs_agent` (not still `twilio_standard`)
- Check that `calls.voice.elevenlabs.voiceId` contains a valid ElevenLabs voice ID
- If mode is `elevenlabs_agent`, ensure `calls.voice.elevenlabs.agentId` is also set

### ElevenLabs mode falls back to standard
When `calls.voice.fallbackToStandardOnError` is `true` (the default), the system silently falls back to standard Twilio TTS if ElevenLabs encounters an error. Check:
- For `elevenlabs_agent` mode: verify the API key is stored (`credential_store action=get service=credential:elevenlabs:api_key`) and that `calls.voice.elevenlabs.agentId` is configured
- For `twilio_elevenlabs_tts` mode: verify `calls.voice.elevenlabs.voiceId` is set to a valid voice ID
- Review daemon logs for error messages related to ElevenLabs
