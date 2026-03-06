---
name: "Twilio Setup"
description: "Configure Twilio credentials and phone numbers for voice calls and SMS messaging"
user-invocable: true
includes: ["public-ingress"]
metadata: { "vellum": { "emoji": "\ud83d\udcf1" } }
---

You are helping your user configure Twilio for voice calls and SMS messaging. Twilio is the shared telephony provider for both the **phone-calls** and **SMS messaging** capabilities. When this skill is invoked, walk through each step below using existing CLI tools and secure credential storage.

## Quick Start

```bash
# 1. Check current status
assistant config get twilio.accountSid
assistant credentials inspect twilio:auth_token --json
assistant config get twilio.phoneNumber
# 2. Store credentials (after collecting via credential_store prompt)
assistant config set twilio.accountSid "ACxxx"
assistant credentials set twilio:auth_token "xxx"
# 3. Get Account SID and Auth Token for Twilio API calls
TWILIO_SID=$(assistant config get twilio.accountSid)
TWILIO_TOKEN=$(assistant credentials reveal twilio:auth_token)
# 4. Search and provision via Twilio API
curl -s -u "$TWILIO_SID:$TWILIO_TOKEN" "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_SID/AvailablePhoneNumbers/US/Local.json?SmsEnabled=true&VoiceEnabled=true"
curl -s -u "$TWILIO_SID:$TWILIO_TOKEN" -X POST "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_SID/IncomingPhoneNumbers.json" -d "PhoneNumber=+1xxx"
# 5. Assign locally (saves to config)
assistant config set twilio.phoneNumber "+1xxx"
```

For voice call setup after Twilio is configured, use `phone-calls` + `call_start`.

## Overview

This skill manages the full Twilio lifecycle:

- **Credential storage** — Auth Token stored securely via `assistant credentials set twilio:auth_token`; Account SID stored in config via `assistant config set twilio.accountSid`
- **Direct Twilio API access** — Search and purchase numbers via the Twilio REST API using credentials retrieved from CLI
- **Phone number assignment** — Assign an existing Twilio number to the assistant via `assistant config set twilio.phoneNumber`
- **Status checking** — Verify credentials and assigned number via `assistant credentials inspect twilio:auth_token` + `assistant config get`

Number search and purchase use direct calls to the Twilio REST API with credentials retrieved via `assistant credentials reveal` and `assistant config get`. Local bookkeeping (Account SID, phone number, config updates) uses `assistant config` commands. Auth Token is stored in encrypted credential storage via `assistant credentials`.

## Step 1: Check Current Configuration

First, check whether Twilio is already configured:

```bash
# Check if Account SID is configured
assistant config get twilio.accountSid

# Check if Auth Token is stored
assistant credentials inspect twilio:auth_token --json
# -> look at "hasSecret" field (true = auth token exists)

# Check assigned phone number
assistant config get twilio.phoneNumber
```

If `twilio.accountSid` returns a value and `hasSecret` is `true` on `twilio:auth_token`, credentials are stored. If `twilio.phoneNumber` also returns a phone number, Twilio is fully configured. Tell the user Twilio is already configured and offer to show the current status or reconfigure.

## Step 2: Collect and Store Credentials

If credentials are not yet stored, guide the user through Twilio account setup:

1. Tell the user: **"You'll need a Twilio account. Sign up at https://www.twilio.com/try-twilio -- it's free to start and includes trial credit."**
2. Once they have an account, they need two pieces of information:
   - **Account SID** -- found on the Twilio Console dashboard at https://console.twilio.com
   - **Auth Token** -- found on the same dashboard (click "Show" to reveal it)

**IMPORTANT -- Secure credential collection only:** Never use credentials pasted in plaintext chat. Always collect credentials through the secure credential prompt flow:

- Call `credential_store` with `action: "prompt"`, `service: "twilio"`, `field: "account_sid"`, `label: "Twilio Account SID"`, `description: "Enter your Account SID from the Twilio Console dashboard"`, and `placeholder: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"`.
- Call `credential_store` with `action: "prompt"`, `service: "twilio"`, `field: "auth_token"`, `label: "Twilio Auth Token"`, `description: "Enter your Auth Token from the Twilio Console dashboard"`, and `placeholder: "your_auth_token"`.

After both credentials are collected, store them using CLI commands:

```bash
assistant config set twilio.accountSid "<value from credential_store for twilio/account_sid>"
assistant credentials set twilio:auth_token "<value from credential_store for twilio/auth_token>"
```

The Account SID is stored in config (it is not a secret), while the Auth Token is stored in encrypted credential storage.

Both values are required. If credentials are invalid, Twilio API calls (Step 3b) will fail -- tell the user and ask them to re-enter via the secure prompt.

## Step 3: Get a Phone Number

The assistant needs a phone number to make calls and send SMS. There are two paths:

### Option A: Provision a New Number

If the user wants to buy a new number through Twilio:

**3a. Retrieve credentials for Twilio API calls:**

```bash
TWILIO_SID=$(assistant config get twilio.accountSid)
TWILIO_TOKEN=$(assistant credentials reveal twilio:auth_token)
```

**3b. Search for available numbers:**

```bash
curl -s -u "$TWILIO_SID:$TWILIO_TOKEN" \
  "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_SID/AvailablePhoneNumbers/US/Local.json?SmsEnabled=true&VoiceEnabled=true&AreaCode=415"
```

- `AreaCode` is optional -- ask the user if they have a preferred area code
- Replace `US` with a different ISO 3166-1 alpha-2 country code if the user wants a non-US number

The response contains an `available_phone_numbers` array. Present the first few options to the user with their `phone_number` and `friendly_name`.

**3c. Purchase the chosen number:**

```bash
curl -s -u "$TWILIO_SID:$TWILIO_TOKEN" -X POST \
  "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_SID/IncomingPhoneNumbers.json" \
  -d "PhoneNumber=+14155551234"
```

The response includes the purchased number's `phone_number` and `sid`.

**3d. Assign locally (saves to config):**

```bash
assistant config set twilio.phoneNumber "+14155551234"
```

This stores the phone number in config.

**Note:** Webhook auto-configuration (voice, status callback, SMS) is not performed by these CLI commands -- this is a known gap requiring a future CLI command (e.g., `assistant integrations twilio sync-webhooks`). Webhooks must be configured manually in the Twilio Console or will be set up when a future CLI command is available.

**Webhook URLs (manual configuration required until CLI support is added):** When `ingress.publicBaseUrl` is configured, the following webhooks should be set on the Twilio phone number:

- Voice webhook: `{publicBaseUrl}/webhooks/twilio/voice`
- Voice status callback: `{publicBaseUrl}/webhooks/twilio/status`
- SMS webhook: `{publicBaseUrl}/webhooks/twilio/sms`

**Trial account note:** Twilio trial accounts come with one free phone number. Check "Active Numbers" in the Twilio Console first before provisioning.

### Option B: Assign an Existing Number

If the user already has a Twilio phone number, first retrieve credentials (same as Option A, step 3a), then list existing numbers:

```bash
curl -s -u "$TWILIO_SID:$TWILIO_TOKEN" \
  "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_SID/IncomingPhoneNumbers.json"
```

The response includes an `incoming_phone_numbers` array with each number's `phone_number`, `friendly_name`, and `capabilities`. Present these to the user and let them choose.

Then assign the chosen number:

```bash
assistant config set twilio.phoneNumber "+14155551234"
```

The phone number must be in E.164 format. **Note:** Webhook auto-configuration is not performed by this CLI command -- this is a known gap. See Step 3d for webhook URLs to configure manually.

### Option C: Manual Entry

If the user wants to enter a number directly (e.g., they know it already), assign it using a CLI command:

```bash
assistant config set twilio.phoneNumber "+14155551234"
```

**Note:** Webhook auto-configuration is not performed by this CLI command -- this is a known gap. See Step 3d for webhook URLs to configure manually.

## Step 4: Set Up Public Ingress

Twilio needs a publicly reachable URL for voice webhooks, ConversationRelay WebSocket, and SMS delivery reports. The **public-ingress** skill handles this via ngrok.

Check if ingress is already configured:

```bash
assistant config get ingress.publicBaseUrl
assistant config get ingress.enabled
```

If not configured, load and run the public-ingress skill:

```
skill_load skill=public-ingress
```

**Twilio webhook endpoints (manual configuration required until CLI support is added):**

- Voice webhook: `{publicBaseUrl}/webhooks/twilio/voice`
- Voice status callback: `{publicBaseUrl}/webhooks/twilio/status`
- ConversationRelay WebSocket: `{publicBaseUrl}/webhooks/twilio/relay` (wss://)
- SMS webhook: `{publicBaseUrl}/webhooks/twilio/sms`

Webhook URLs must be manually configured on the Twilio phone number in the Twilio Console. A future CLI command (e.g., `assistant integrations twilio sync-webhooks`) will automate this.

## Step 5: Verify Setup

After configuration, verify by checking credential and config status:

```bash
assistant config get twilio.accountSid
assistant credentials inspect twilio:auth_token --json
assistant config get twilio.phoneNumber
```

Confirm:

- `twilio.accountSid` returns the Account SID
- `hasSecret` is `true` on `twilio:auth_token`
- `twilio.phoneNumber` returns the expected phone number

Tell the user: **"Twilio is configured. Your assistant's phone number is {phoneNumber}. This number is used for both voice calls and SMS messaging."**

## Step 5.5: Guardian Verification (Voice)

Now link the user's phone number as the trusted voice guardian. Tell the user: "Now let's verify your guardian identity for voice. This links your phone number so the assistant can verify inbound callers."

Load the **guardian-verify-setup** skill to handle the verification flow:

- Call `skill_load` with `skill: "guardian-verify-setup"` to load the dependency skill.

When invoking the skill, indicate the channel is `voice`. The guardian-verify-setup skill manages the full outbound verification flow, including:

- Collecting the user's phone number as the destination (accepts any common format -- the API normalizes to E.164)
- Starting the outbound verification session via the gateway endpoint `POST /v1/integrations/guardian/outbound/start` with `channel: "voice"`
- Calling the phone number and providing a code for the user to enter via their phone's keypad
- Proactively polling for completion (voice auto-check) so the user gets instant confirmation
- Checking guardian status to confirm the binding was created
- Handling resend, cancel, and error cases

Tell the user: _"I've loaded the guardian verification guide. It will walk you through linking your phone number as the trusted voice guardian."_

After the guardian-verify-setup skill completes (or the user skips), continue to Step 6.

**Note:** Guardian verification is optional but recommended. If the user declines or wants to skip, proceed to Step 6 without blocking.

To re-check guardian status later:

```bash
assistant integrations guardian status --channel voice --json
```

## Step 6: Enable Features

Now that Twilio is configured, the user can enable the features that depend on it:

**For voice calls:**

```bash
assistant config set calls.enabled true
```

**For SMS messaging:**
SMS is available automatically once Twilio is configured -- no additional feature flag is needed.

## Clearing Credentials

If the user wants to disconnect Twilio:

```bash
assistant credentials delete twilio:auth_token
assistant config set twilio.accountSid ""
```

This deletes the Auth Token from encrypted storage and clears the Account SID from config. Phone number assignments are preserved. Voice calls and SMS will stop working until credentials are reconfigured.

## Troubleshooting

### "Twilio credentials not configured"

Run Steps 2 and 3 to store credentials and assign a phone number.

### "No phone number assigned"

Run Step 3 to provision or assign a phone number.

### Phone number provisioning fails

- Verify Twilio credentials are correct
- On trial accounts, you may already have a free number -- check "Active Numbers" in the Console
- Ensure the Twilio account has sufficient balance for paid accounts

### Calls/SMS fail after setup

- Verify public ingress is running (`ingress.publicBaseUrl` must be set)
- For calls, ensure `calls.enabled` is `true`
- On trial accounts, outbound calls and SMS can only reach verified numbers

### "Number not found" when assigning

- The number must be owned by the same Twilio account
- Use the list numbers endpoint to see available numbers
- Ensure the number is in E.164 format (`+` followed by country code and number)

## Known Gaps (Future CLI Commands Needed)

The following operations were previously handled by gateway API endpoints and
do not yet have CLI equivalents:

1. **Webhook auto-configuration** -- Voice, status callback, and SMS webhook
   URLs are not automatically set on the Twilio phone number. Configure
   webhooks manually in the Twilio Console or wait for a future CLI command.
2. **Stale phone number pruning** -- Stale phone number mappings are not
   automatically cleaned up.
