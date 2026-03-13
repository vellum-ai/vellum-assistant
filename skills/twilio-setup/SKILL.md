---
name: twilio-setup
description: Configure Twilio credentials and phone numbers for voice calls
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "📱"
  vellum:
    display-name: "Twilio Setup"
    user-invocable: true
    includes: ["public-ingress"]
---

You are helping your user configure Twilio for voice calls. Walk through each step below.

## Value Classification

Before you begin, understand how each Twilio value is stored:

| Value        | Type       | Storage method                                                  | Secret? |
| ------------ | ---------- | --------------------------------------------------------------- | ------- |
| Account SID  | Config     | `assistant config set twilio.accountSid`                        | No      |
| Auth Token   | Credential | `assistant credentials set --service twilio --field auth_token` | **Yes** |
| Phone Number | Config     | `assistant config set twilio.phoneNumber`                       | No      |

- **Config values** (Account SID, Phone Number) are non-sensitive identifiers. Collect them via normal conversation -- the user can paste them in chat or you can use `AskUserQuestion`.
  **Auth Token** is a secret. Collect it securely via `credential_store` prompt -- never accept it pasted in plaintext chat.

## Retrieving Twilio Credentials

Many steps below require the Account SID and Auth Token. Retrieve them with:

```bash
TWILIO_SID=$(assistant config get twilio.accountSid)
TWILIO_TOKEN=$(assistant credentials reveal --service twilio --field auth_token)
```

# Checking Current Configuration

You can determine whether Twilio has been fully set up by checking to see that all the following config and credential values have been set:

```bash
assistant config get twilio.accountSid
assistant credentials inspect --service twilio --field auth_token --json  # check "hasSecret" field
assistant config get twilio.phoneNumber
```

- If all three config values are non-empty -- Twilio is fully configured. Offer to show status or reconfigure.
- Otherwise, continue to the missing steps.

# Twilio Setup Steps

Follow the steps below in order to fully configure Twilio in preparation to make phone calls.

## Step 1: Check Current Configuration

Refer to "Checking Current Configuration" above to see the current state of the user's Twilio setup. If Twilio appears to be fully configured. Offer to show status or reconfigure. Otherwise, continue to the missing steps below.

## Step 2: Collect and Store Credentials

Tell the user: **"You'll need a Twilio account. Sign up at https://www.twilio.com/try-twilio -- it's free to start and includes trial credit."**

They need two values from the Twilio Console dashboard (https://console.twilio.com):

- **Account SID** -- visible on the dashboard, starts with `AC` (this is not a secret value and can be collected conversationally)
- **Auth Token** -- click "Show" to reveal (this is a secret value and should be collected securely)

### Collect Account SID

Ask the user for their Account SID. This is NOT a secret value, so the user should be encouraged to comfortable paste it into the chat directly. Once they have, store it as a config value:

```bash
assistant config set twilio.accountSid "<Account SID from user>"
```

### Collect Auth Token

Ask the user for their Auth Token. This IS a secret value, so the user should be prompted to enter the value securely. Do NOT ask them to provide it in the chat. Once they have, store it as a credential:

- Call `credential_store` with `action: "prompt"`, `service: "twilio"`, `field: "auth_token"`, `label: "Twilio Auth Token"`, `description: "Enter your Auth Token from the Twilio Console dashboard (click 'Show' to reveal it)"`, `placeholder: "your_auth_token"`.

Confirm it has been stored successfully:

```bash
assistant credentials inspect --service twilio --field auth_token
```

If credentials are invalid, Twilio API calls in Step 3 will fail -- ask the user to re-enter.

## Step 3: Get a Phone Number

The assistant needs a phone number for voice calls. Three options:

### Option A: Use an Existing Number

You should assume this option if the user had just created their Twilio account. Trial accounts come with one free number.

Retrieve credentials, then list numbers on the account:

```bash
curl -s -u "$TWILIO_SID:$TWILIO_TOKEN" \
  "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_SID/IncomingPhoneNumbers.json"
```

Present the `incoming_phone_numbers` array. Let the user choose.

### Option B: Provision a New Number

Retrieve credentials (see "Retrieving Twilio Credentials" above), then:

**Search for available numbers:**

```bash
curl -s -u "$TWILIO_SID:$TWILIO_TOKEN" \
  "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_SID/AvailablePhoneNumbers/US/Local.json?VoiceEnabled=true&AreaCode=415"
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

### Option C: Manual Entry

If the user already has a number and knows it, skip the API calls. They can paste it directly in chat.

### Save the phone number

After choosing a number via any option, store it as a config value:

```bash
assistant config set twilio.phoneNumber "+14155551234"
```

## Step 4: Set Up Public Ingress and Webhooks

### Verify Public Ingress is Set Up

Twilio needs a publicly reachable URL for voice webhooks. Load the `public-ingress` skill to determine whether a public ingress has been configured and walk the user through setting one up if not.

### Configure Twilio Webhooks

Set webhook URLs on the phone number so Twilio routes traffic to the assistant.

Retrieve credentials and config values:

```bash
TWILIO_SID=$(assistant config get twilio.accountSid)
TWILIO_TOKEN=$(assistant credentials reveal --service twilio --field auth_token)
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
  -d "StatusCallback=$PUBLIC_URL/webhooks/twilio/status"
```

## Clearing Credentials

To disconnect Twilio:

```bash
assistant credentials delete --service twilio --field auth_token
assistant config set twilio.accountSid ""
```

Phone number assignments are preserved. Voice calls will stop until credentials are reconfigured.

## Troubleshooting

### "Twilio credentials not configured"

Run Steps 2 and 3.

### "No phone number assigned"

Run Step 3.

### Phone number provisioning fails

- Verify credentials are correct
- Trial accounts may already have a free number -- check "Active Numbers" in the Console
- Ensure the account has sufficient balance

### Calls fail after setup

- Verify ingress is running: `assistant config get ingress.publicBaseUrl`
- For calls, ensure `calls.enabled` is `true`
- Trial accounts can only reach verified numbers

### Incoming calls not reaching the assistant

Webhooks on the Twilio phone number may not match the current ingress URL. This happens when ngrok restarts with a new URL or webhooks were never configured.

**Diagnose** -- fetch the number's current webhooks and compare to the expected URL:

```bash
TWILIO_SID=$(assistant config get twilio.accountSid)
TWILIO_TOKEN=$(assistant credentials reveal --service twilio --field auth_token)
PUBLIC_URL=$(assistant config get ingress.publicBaseUrl)
PHONE_NUMBER=$(assistant config get twilio.phoneNumber)

curl -s -u "$TWILIO_SID:$TWILIO_TOKEN" \
  "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_SID/IncomingPhoneNumbers.json?PhoneNumber=$PHONE_NUMBER"
```

Check that `voice_url` and `status_callback` start with the current `ingress.publicBaseUrl`. If they don't match, update them:

```bash
PHONE_SID=<PN sid from the response above>
curl -s -u "$TWILIO_SID:$TWILIO_TOKEN" -X POST \
  "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_SID/IncomingPhoneNumbers/$PHONE_SID.json" \
  -d "VoiceUrl=$PUBLIC_URL/webhooks/twilio/voice" \
  -d "StatusCallback=$PUBLIC_URL/webhooks/twilio/status"
```
