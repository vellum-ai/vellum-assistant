---
name: phone-calls
description: "Make outgoing phone calls, receive incoming calls, and pull up past call transcripts"
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "📞"
  vellum:
    display-name: "Phone Calls"
    includes:
      - "twilio-setup"
      - "public-ingress"
      - "elevenlabs-voice"
    activation-hints:
      - "Phone calling setup, Twilio config, placing/receiving calls"
      - "Do NOT improvise Twilio setup from general knowledge"
    avoid-when:
      - "Don't confuse with voice-setup (local PTT/mic) or user-verify-setup"
---

You are helping the user set up and manage phone calls via Twilio. This skill covers enabling the calls feature, placing outbound calls, receiving inbound calls, and interacting with live calls. Twilio credential storage, phone number provisioning, and public ingress are handled by the **twilio-setup** skill.

## External Identity

When speaking on behalf of your user during calls, refer to yourself as an "assistant" (not "AI assistant"). Use your user's name and pronouns from USER.md. Don't volunteer that you are an AI unless directly asked.

# Overview

The calling system uses Twilio's ConversationRelay for both **outbound** and **inbound** voice calls with **ElevenLabs** providing the text-to-speech voice. After Twilio setup, the assistant configures ElevenLabs as the TTS provider and prompts the user to choose a voice from a curated list of supported options.

# Initial Setup

Follow the steps below to ensure everything is prepared to make and receive phone calls.

## Step 1: Twilio Setup

Load the `twilio-setup` skill to determine whether Twilio has been fully configured and set it up if not. This is a prerequisite to all subsequent steps.

## Step 2: Enable Calls

Once Twilio is confirmed to be fully configured, enable calls by updating the config:

```bash
assistant config set calls.enabled true
```

Verify:

```bash
assistant config get calls.enabled
```

## Step 3: Choose a Voice

Voice selection and tuning are handled by the `elevenlabs-voice` skill. Follow the instructions there to pick a curated voice, optionally set up an ElevenLabs API key for advanced selection, or tune voice parameters.

## Step 4: Verify Setup (Test Call)

Before making real calls, offer a quick verification. Suggest a test call to the user's own phone: **"Want to do a quick test call to your phone to make sure everything works? This is a good way to make sure everything works and that you like the way I sound."**

If they agree, ask for their personal phone number and place a test call with a simple task like "Introduce yourself and confirm the call system is working."

## Step 5: Guardian Verification

The final step is for the user to verify themselves so that they are recognized when they call you. It's also a great way for them to hear what you sound like and decide if they want you to use a different voice.

Load the `guardian-verify-setup` skill and follow the instructions for guardian verification over the `phone` channel. This will require the user to provide you with their phone number and then for you to give them a call. Say something like:

> Want to do a quick verification call now so that you can hear what I sound like and also so that I recognize your number when you call me in the future?
> I'll show a 6 digit code here in the chat and when you answer my call, enter it using your phone's keypad.

You can check their verification status with:

```bash
assistant channel-verification-sessions status --channel phone --json
```

After they are verified, ask them what they think of your voice and offer to let them change it. Load up the `elevenlabs-voice` skill and follow the instructions there to see what voices are available and how to update your configured voice. Say something like:

> Great, you're verified! What did you think of my voice? We can update it if you'd like.


# Making Outbound Calls

Use the `call_start` tool to place outbound calls. Every call requires:

- **phone_number**: The number to call in E.164 format (e.g. `+14155551234`)
- **task**: What the call should accomplish - this becomes the AI voice agent's objective
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

# Receiving Inbound Calls

Once Twilio is configured and the assistant has a phone number, inbound calls work automatically. When someone dials the assistant's number:

1. The gateway resolves the assistant by phone number and forwards to the runtime
2. A new voice session is created, keyed by the Twilio CallSid
3. The LLM-driven orchestrator answers in receptionist mode - greeting the caller warmly and asking how it can help
4. The conversation proceeds naturally, with ASK_GUARDIAN dispatches to consult the user when needed

No additional configuration is needed beyond Twilio setup and `calls.enabled` being `true`. As long as the phone number has been provisioned/assigned, inbound calls are handled automatically.

### Guardian voice verification for inbound calls

To set up guardian verification, load the skill: `skill_load skill=guardian-verify-setup`. Once a guardian binding exists, inbound callers may be prompted for verification before calls proceed.

# Interacting with a Live Call

During an active call, the user can interact with the AI voice agent via the HTTP API endpoints. After placing a call with `call_start`, use `call_status` to poll the call state.

#### Answering questions

When the AI voice agent encounters something it needs user input for, it dispatches an **ASK_GUARDIAN** request to all configured guardian channels (mac desktop, Telegram). The call status changes to `waiting_on_user`.

1. The question is delivered simultaneously to every configured channel. The first channel to respond wins (first-response-wins semantics) -- once one channel provides an answer, the other channels receive a "already answered" notice.
2. On the mac desktop, a guardian request conversation is created with the question. On Telegram, the question text and a request code are delivered via the gateway.
3. If DTMF callee verification is enabled, the callee must enter a verification code before the call proceeds (see the **DTMF Callee Verification** section above).
4. The guardian provides an answer through whichever channel they prefer. The answer is routed to the AI voice agent, which continues the conversation naturally.

**Important:** Respond to pending questions quickly. There is a consultation timeout (default: 2 minutes). If no answer is provided in time, the AI voice agent will move on.

#### Guardian timeout and follow-up

When a consultation times out, the voice agent apologizes to the caller and moves on -- but the interaction is not lost. If the guardian responds after the timeout:

1. **Late reply detection**: The system recognizes the late answer on whichever channel it arrives (desktop or Telegram) and presents a follow-up prompt asking the guardian what they would like to do.
2. **Follow-up options**: The guardian can choose to:
   - **Call back** the original caller with the answer
   - **Send a text message** to the caller with the answer
   - **Decline** if the follow-up is no longer needed
3. **Automatic execution**: If the guardian chooses to call back or send a message, the system resolves the original caller's phone number from the call record and executes the action automatically -- placing an outbound callback call or sending a message via the gateway.

All user-facing messages in this flow (timeout acknowledgments, follow-up prompts, completion confirmations) are generated by the assistant to maintain a natural, conversational tone. No fixed/canned responses are used.

The follow-up flow works across all guardian channels. The guardian can receive the timeout notice on Telegram and choose to call back -- the system handles cross-channel routing transparently.

#### Steering with instructions

When there is **no pending question** but the call is still active, the user can send steering instructions via the HTTP API (`POST /v1/calls/:id/instruction`) to proactively guide the call in real time - for example:

- "Ask them about their cancellation policy too"
- "Wrap up the call, we have what we need"
- "Switch to asking about weekend availability instead"
- "Be more assertive about getting a discount"

The instruction is injected into the AI voice agent's conversation context as high-priority input, and the agent adjusts its behavior accordingly.

**Note:** Steering is done via the HTTP API, not the desktop chat conversation. The desktop conversation only receives pointer/status messages about the call.

### Call status values

- **initiated** - Call is being placed
- **ringing** - Phone is ringing on the other end
- **in_progress** - Call is connected, conversation is active
- **waiting_on_user** - AI agent needs input from the user (check pending question)
- **completed** - Call ended successfully
- **failed** - Call failed (check lastError for details)
- **cancelled** - Call was manually cancelled

### Ending a call early

Use `call_end` with the call session ID to terminate an active call:

```
call_end call_session_id="<session_id>" reason="User requested to end the call"
```

# Reference

For detailed information on the following topics, see the reference files:

- **[Retrieving Past Call Transcripts](references/TRANSCRIPTS.md)** - How to find and query full bidirectional call transcripts from the database
- **[Configuration Reference & Call Quality Tips](references/CONFIG.md)** - All call-related config settings, defaults, and tips for writing effective call tasks
- **[Troubleshooting](references/TROUBLESHOOTING.md)** - Common error messages, connectivity issues, and debugging steps
