---
name: "Twilio Setup"
description: "Configure Twilio credentials and phone numbers for voice calls and SMS messaging"
user-invocable: true
includes: ["public-ingress"]
metadata: { "vellum": { "emoji": "\ud83d\udcf1" } }
---

You are helping your user configure Twilio for voice calls and SMS messaging. Walk through each step below.

## Retrieving Twilio Credentials

Many steps below require the Account SID and Auth Token. Retrieve them with:

```bash
TWILIO_SID=$(assistant config get twilio.accountSid)
TWILIO_TOKEN=$(assistant credentials reveal twilio:auth_token)
```

## Step 1: Check Current Configuration

```bash
assistant config get twilio.accountSid
assistant credentials inspect twilio:auth_token --json  # check "hasSecret" field
assistant config get twilio.phoneNumber
```

- If `twilio.accountSid` has a value, `hasSecret` is `true`, and `twilio.phoneNumber` is set -- Twilio is fully configured. Offer to show status or reconfigure.
- Otherwise, continue to the missing steps.

## Step 2: Collect and Store Credentials

Tell the user: **"You'll need a Twilio account. Sign up at https://www.twilio.com/try-twilio -- it's free to start and includes trial credit."**

They need two values from the Twilio Console dashboard (https://console.twilio.com):

- **Account SID**
- **Auth Token** (click "Show" to reveal)

Collect them securely -- never accept credentials pasted in plaintext chat:

- Call `credential_store` with `action: "prompt"`, `service: "twilio"`, `field: "account_sid"`, `label: "Twilio Account SID"`, `description: "Enter your Account SID from the Twilio Console dashboard"`, `placeholder: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"`.
- Call `credential_store` with `action: "prompt"`, `service: "twilio"`, `field: "auth_token"`, `label: "Twilio Auth Token"`, `description: "Enter your Auth Token from the Twilio Console dashboard"`, `placeholder: "your_auth_token"`.

Then store them:

```bash
assistant config set twilio.accountSid "<value from credential_store for twilio/account_sid>"
assistant credentials set twilio:auth_token "<value from credential_store for twilio/auth_token>"
```

If credentials are invalid, Twilio API calls in Step 3 will fail -- ask the user to re-enter.

## Step 3: Get a Phone Number

The assistant needs a phone number for calls and SMS. Three options:

### Option A: Provision a New Number

Retrieve credentials (see "Retrieving Twilio Credentials" above), then:

**Search for available numbers:**

```bash
curl -s -u "$TWILIO_SID:$TWILIO_TOKEN" \
  "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_SID/AvailablePhoneNumbers/US/Local.json?SmsEnabled=true&VoiceEnabled=true&AreaCode=415"
```

- `AreaCode` is optional -- ask the user if they have a preference
- Replace `US` with another country code if needed

Present the first few results from the `available_phone_numbers` array (show `phone_number` and `friendly_name`).

**Purchase the chosen number:**

```bash
curl -s -u "$TWILIO_SID:$TWILIO_TOKEN" -X POST \
  "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_SID/IncomingPhoneNumbers.json" \
  -d "PhoneNumber=+14155551234"
```

Note the `sid` field (starts with `PN`) from the response -- needed for webhook setup in Step 4.

**Trial account note:** Trial accounts come with one free number. Check "Active Numbers" in the Console first.

### Option B: Use an Existing Number

Retrieve credentials, then list numbers on the account:

```bash
curl -s -u "$TWILIO_SID:$TWILIO_TOKEN" \
  "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_SID/IncomingPhoneNumbers.json"
```

Present the `incoming_phone_numbers` array. Let the user choose.

### Option C: Manual Entry

If the user already knows their number, skip the API calls.

### Save the phone number

After choosing a number via any option:

```bash
assistant config set twilio.phoneNumber "+14155551234"
```

## Step 4: Set Up Public Ingress and Webhooks

Twilio needs a publicly reachable URL for voice webhooks and SMS delivery. Check if ingress is configured:

```bash
assistant config get ingress.publicBaseUrl
assistant config get ingress.enabled
```

If not configured, load the public-ingress skill:

```
skill_load skill=public-ingress
```

### Configure Twilio Webhooks

Set webhook URLs on the phone number so Twilio routes traffic to the assistant.

Retrieve credentials and config values:

```bash
TWILIO_SID=$(assistant config get twilio.accountSid)
TWILIO_TOKEN=$(assistant credentials reveal twilio:auth_token)
PUBLIC_URL=$(assistant config get ingress.publicBaseUrl)
PHONE_NUMBER=$(assistant config get twilio.phoneNumber)
```

Look up the phone number's SID:

```bash
curl -s -u "$TWILIO_SID:$TWILIO_TOKEN" \
  "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_SID/IncomingPhoneNumbers.json?PhoneNumber=$PHONE_NUMBER"
```

Note the `sid` field (starts with `PN`) from the matching entry, then update webhooks:

```bash
curl -s -u "$TWILIO_SID:$TWILIO_TOKEN" -X POST \
  "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_SID/IncomingPhoneNumbers/$PHONE_SID.json" \
  -d "VoiceUrl=$PUBLIC_URL/webhooks/twilio/voice" \
  -d "StatusCallback=$PUBLIC_URL/webhooks/twilio/status" \
  -d "SmsUrl=$PUBLIC_URL/webhooks/twilio/sms"
```

## Step 5: Verify and Enable

Re-run the checks from Step 1 to confirm everything is set. Then enable voice calls:

```bash
assistant config set calls.enabled true
```

SMS is available automatically once Twilio is configured -- no flag needed.

Tell the user: **"Twilio is configured. Your assistant's phone number is {phoneNumber}."**

## Step 6: Guardian Verification (Optional)

Link the user's phone number as the trusted voice guardian so the assistant can verify inbound callers.

Load the guardian-verify-setup skill with `channel: "voice"`:

```
skill_load skill=guardian-verify-setup
```

The skill handles the full verification flow (outbound call, code entry, confirmation). If the user declines, skip this step.

To re-check guardian status later:

```bash
assistant integrations guardian status --channel voice --json
```

## Clearing Credentials

To disconnect Twilio:

```bash
assistant credentials delete twilio:auth_token
assistant config set twilio.accountSid ""
```

Phone number assignments are preserved. Voice calls and SMS will stop until credentials are reconfigured.

## Troubleshooting

### "Twilio credentials not configured"

Run Steps 2 and 3.

### "No phone number assigned"

Run Step 3.

### Phone number provisioning fails

- Verify credentials are correct
- Trial accounts may already have a free number -- check "Active Numbers" in the Console
- Ensure the account has sufficient balance

### Calls/SMS fail after setup

- Verify ingress is running: `assistant config get ingress.publicBaseUrl`
- For calls, ensure `calls.enabled` is `true`
- Trial accounts can only reach verified numbers

### Incoming calls/SMS not reaching the assistant

Webhooks on the Twilio phone number may not match the current ingress URL. This happens when ngrok restarts with a new URL or webhooks were never configured.

**Diagnose** -- fetch the number's current webhooks and compare to the expected URL:

```bash
TWILIO_SID=$(assistant config get twilio.accountSid)
TWILIO_TOKEN=$(assistant credentials reveal twilio:auth_token)
PUBLIC_URL=$(assistant config get ingress.publicBaseUrl)
PHONE_NUMBER=$(assistant config get twilio.phoneNumber)

curl -s -u "$TWILIO_SID:$TWILIO_TOKEN" \
  "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_SID/IncomingPhoneNumbers.json?PhoneNumber=$PHONE_NUMBER"
```

Check that `voice_url`, `status_callback`, and `sms_url` start with the current `ingress.publicBaseUrl`. If they don't match, update them:

```bash
PHONE_SID=<PN sid from the response above>
curl -s -u "$TWILIO_SID:$TWILIO_TOKEN" -X POST \
  "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_SID/IncomingPhoneNumbers/$PHONE_SID.json" \
  -d "VoiceUrl=$PUBLIC_URL/webhooks/twilio/voice" \
  -d "StatusCallback=$PUBLIC_URL/webhooks/twilio/status" \
  -d "SmsUrl=$PUBLIC_URL/webhooks/twilio/sms"
```
